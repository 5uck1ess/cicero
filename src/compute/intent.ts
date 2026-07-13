export interface ActionRequest {
  isAction: boolean;
  /** The goal text with the trigger phrase stripped (empty when isAction is false). */
  goal: string;
}

// v1 uses EXPLICIT triggers rather than bare action verbs, so it never hijacks
// ordinary questions ("summarize this article") or existing tab/brain routing
// ("open the sales tab"). Broaden once the behavior is verified on hardware.
const TRIGGERS: RegExp[] = [
  /^(?:hey\s+|ok\s+|okay\s+)?computer[,!.\s]+/i,
  /^(?:please\s+)?use (?:the|your) computer to\s+/i,
  /^(?:please\s+)?take action(?:\s+and)?\s+/i,
  /^(?:please\s+)?go ahead and\s+/i,
];

/**
 * Detects an explicit spoken/typed request to take a computer action and extracts
 * the goal. Returns isAction:false (and an empty goal) for everything else, so the
 * normal conversational path is the default.
 */
export function parseActionRequest(transcript: string): ActionRequest {
  const text = transcript.trim();
  for (const trigger of TRIGGERS) {
    const match = text.match(trigger);
    if (!match) continue;
    const goal = text.slice(match[0].length).trim();
    if (goal) return { isAction: true, goal };
  }
  return { isAction: false, goal: "" };
}
