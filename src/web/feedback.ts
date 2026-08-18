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
 * have to think in points, and never have to decode a label — an earlier
 * "right item, wrong position" read as jargon and has since been dropped
 * entirely.
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
    // Broader than it started. It was "dealt with by call, text, in person",
    // which named one cause and quietly excluded the commoner one: a thread that
    // simply needs nothing — a closed ticket, an acknowledgement, an FYI. Both
    // want the same outcome, which is for that conversation to stop asking.
    label: "Handled, or needs nothing from me",
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
 * Kept separate from the demotions because it does not mean "this should not
 * have been in the brief" — it means it belonged there and the wording was off.
 * Sending it to a sender rule would suppress mail he actually wants.
 *
 * There is deliberately no "wrong position" option. Ordering within the section
 * does not matter to him: what matters is whether something is in the brief at
 * all. Collecting rank complaints would have produced a pile of verdicts nobody
 * intended to act on, which is worse than not asking.
 */
export const PRESENTATION_CHOICES: readonly FeedbackChoice[] = [
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
 * Why a priority was wrong.
 *
 * These were four options that all declared the same effect, "Recorded against
 * the priorities prompt", and all collapsed to the same stored verdict. Choosing
 * between them changed nothing, which is exactly what made the menu feel vague
 * next to the attention one, where every option routes somewhere different and
 * says so.
 *
 * They now name the failures the briefs actually produced rather than abstract
 * qualities, and each one that generalises carries the standing instruction it
 * proposes. The console counts them and offers that instruction for adoption
 * once there is a pattern. Nothing is written to the prompt automatically: a
 * suggestion engine acting unsupervised is the drift this whole layer exists to
 * avoid, so it proposes and he decides.
 */
export interface PriorityChoice {
  id: string;
  label: string;
  effect: string;
  /**
   * The standing instruction this complaint argues for, or null when it is about
   * this one priority and generalises to nothing.
   */
  proposes: string | null;
}

export const PRIORITY_CHOICES: readonly PriorityChoice[] = [
  {
    id: "priority-vague",
    label: "Too general to act on",
    effect: "Suggests a rule requiring a name or a deadline",
    proposes:
      "Every priority must name a specific person, thread, meeting, or deadline. " +
      "Never write a general instruction like staying on top of something.",
  },
  {
    id: "priority-meeting-prep",
    label: "Just says to prepare for a meeting",
    effect: "Suggests a rule dropping meeting prep priorities",
    proposes:
      "Never write a priority whose only content is preparing for a meeting, " +
      "writing an agenda for one, or setting an objective for a calendar block. " +
      "He can see his own calendar.",
  },
  {
    id: "priority-duplicate",
    label: "Already said under Needs attention",
    effect: "Suggests a rule against reporting the same thing twice",
    proposes:
      "When a priority is about a thread in the attention list, claim that " +
      "thread in covers and write the priority so it carries the whole point. " +
      "Never let the same item appear in both sections.",
  },
  {
    id: "priority-invented",
    label: "Says something that is not true",
    effect: "Suggests a rule against inventing detail",
    proposes:
      "Never invent detail to sound concrete. If nothing in the input says he " +
      "has a given number of asks, decisions, or blockers, do not write that he does.",
  },
  {
    id: "priority-not-mine",
    label: "Not mine to do today",
    effect: "Recorded against this morning only",
    proposes: null,
  },
  {
    id: "priority-missing",
    label: "Something more important than this was left out",
    effect: "Recorded as a gap, not as a badly written priority",
    proposes: null,
  },
] as const;

export function priorityChoiceById(id: string): PriorityChoice | null {
  return PRIORITY_CHOICES.find((c) => c.id === id) ?? null;
}

export function isPriorityChoice(id: string): boolean {
  return id === "priority-good" || PRIORITY_CHOICES.some((c) => c.id === id);
}

/**
 * What a recorded verdict reads as once it is in.
 *
 * Every choice needs an entry, including the ones with no menu behind them
 * ("good", "missed"), because the page shows what was already decided rather
 * than offering the buttons again — pressing one twice would count one opinion
 * as two votes and make a rule stronger than the evidence behind it.
 */
const EXTRA_LABELS: Record<string, string> = {
  good: "Good call",
  "priority-good": "Good call",
  missed: "Should have been in the brief",
  "not-missed": "Right to leave out",
};

export function verdictLabel(choiceId: string | null): string {
  if (!choiceId) return "Judged";
  return (
    EXTRA_LABELS[choiceId] ??
    ALL_CHOICES.find((c) => c.id === choiceId)?.label ??
    PRIORITY_CHOICES.find((c) => c.id === choiceId)?.label ??
    "Judged"
  );
}

/** Whether a recorded choice was an approval, for how it is coloured. */
export function isApproval(choiceId: string | null): boolean {
  return choiceId === "good" || choiceId === "priority-good" || choiceId === "not-missed";
}

/**
 * A priority has no thread key, so its verdict is tied to its position.
 *
 * Written by the feedback handler and read back by the briefs page. The two
 * live in different files and neither would fail loudly if the format drifted —
 * the page would simply stop knowing what had been judged and offer the buttons
 * again — so the format is defined once, here, and tested.
 */
export function priorityNote(index: number, text: string): string {
  return `priority ${index}: ${text.slice(0, 300)}`;
}

export function priorityIndexFromNote(note: string | null): number | null {
  const found = /^priority (\d+):/.exec(note ?? "");
  return found ? Number.parseInt(found[1]!, 10) : null;
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
