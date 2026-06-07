export type NavigatorPromptClassification = "likely_orientation" | "skip_nudge";

export interface NavigatorPromptReadinessFacts {
  repoResolved: boolean;
  selectedTools: readonly string[] | undefined;
  coverage: { total: number; indexed: number };
  fullCrawlDone: boolean;
  indexedHead: string | undefined;
  currentHead: string | null;
  dirty: boolean;
  workerFailed: boolean;
}

export interface BuildNavigatorPromptGuidanceArgs {
  prompt: string;
  persona: string;
  readiness: NavigatorPromptReadinessFacts;
}

export const NAVIGATOR_PROMPT_NUDGE =
  "This request likely needs repo orientation. If no exact path is already known, call `navigator_locate` once before `rg`/`find`/`read`.";

const PATH_WITH_SLASH_RE =
  /(^|[\s("'`])(?:\.\.?\/)?(?:[\w.-]+\/)+[\w.-]+(?:\.[a-z0-9]+)+(?:\:\d+(?:\:\d+)?)?(?=$|[\s)"'`.,!?])/i;

const STANDALONE_FILENAME_RE =
  /(^|[\s("'`])(?:README\.md|AGENTS\.md|package\.json|[\w.-]+(?:\.test)?\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|md|json|toml|ya?ml))(?:\:\d+(?:\:\d+)?)?(?=$|[\s)"'`.,!?])/i;

const URL_RE = /https?:\/\//i;
const TICKET_OR_PR_RE = /\b(?:linear|ticket|issue|github issue|github pr|pr|pull request)\b/i;
const PR_COMMENTS_RE = /\b(?:github\s+)?pr comments?\b/i;
const NEGATED_CODE_IMPACT_RE = /without asking for code impact/gi;

function normalizePrompt(prompt: string): string {
  return prompt.toLowerCase().trim();
}

function hasCodeImpactIntent(normalizedPrompt: string): boolean {
  const sanitized = normalizedPrompt.replaceAll(NEGATED_CODE_IMPACT_RE, " ");
  return [
    /\bwhat code needs to change\b/i,
    /\bcode needs to change\b/i,
    /\btell me what code needs to change\b/i,
    /\bidentify implementation changes?\b/i,
    /\bimplementation changes?\b/i,
    /\bwhat needs changing\b/i,
    /\bneeds changing\b/i,
    /\bactionable code changes?\b/i,
    /\bimplementation\b/i,
    /\bfix\b/i,
  ].some((pattern) => pattern.test(sanitized));
}

function hasBroadRepoTrigger(normalizedPrompt: string): boolean {
  return [
    /\binvestigate\b/i,
    /\breview\s+(?:this\s+)?(?:linear|ticket|issue|github issue|github pr|pr|pull request|pr)\b/i,
    /\bwhat needs changing\b/i,
    /\bwhat code needs to change\b/i,
    /\bwhere is\b.*\bimplemented\b/i,
    /\bfix\b/i,
    /\badd support\b/i,
    /\blook into\b/i,
    /\bis this actionable\b/i,
    /\bexplain how\b/i,
    /\bfind where\b/i,
  ].some((pattern) => pattern.test(normalizedPrompt));
}

function hasTicketOrPrCodeImpactTrigger(normalizedPrompt: string): boolean {
  return TICKET_OR_PR_RE.test(normalizedPrompt) && hasCodeImpactIntent(normalizedPrompt);
}

export function hasExactLocalPath(prompt: string): boolean {
  return PATH_WITH_SLASH_RE.test(prompt) || STANDALONE_FILENAME_RE.test(prompt);
}

export function isExternalOnlyPrompt(prompt: string): boolean {
  const normalizedPrompt = normalizePrompt(prompt);

  if (!normalizedPrompt || hasExactLocalPath(prompt)) {
    return false;
  }

  if (PR_COMMENTS_RE.test(normalizedPrompt) && !hasCodeImpactIntent(normalizedPrompt)) {
    return true;
  }

  if (hasBroadRepoTrigger(normalizedPrompt) || hasTicketOrPrCodeImpactTrigger(normalizedPrompt) || hasCodeImpactIntent(normalizedPrompt)) {
    return false;
  }

  if (URL_RE.test(normalizedPrompt)) {
    return true;
  }

  return [
    /\bwhat branch am i on\b/i,
    /\bshow git status\b/i,
    /\breport git branch information only\b/i,
    /\bgit (?:branch|status|log)\b/i,
    /\bslack\b/i,
    /\bsentry\b/i,
    /\bdatabase schema\b/i,
  ].some((pattern) => pattern.test(normalizedPrompt));
}

// Recall-first: an in-repo session prompt is treated as orientation by default.
// We only suppress the nudge for the two closed, enumerable exclusion sets —
// an exact local path/filename, or a purely external/status request. Enumerating
// every orientation phrasing is an open set and was the prior brittle approach;
// enumerating the exclusions is bounded. The broad-trigger helpers remain as
// anti-exclusion guards inside isExternalOnlyPrompt.
export function classifyNavigatorPrompt(prompt: string): NavigatorPromptClassification {
  if (!normalizePrompt(prompt)) {
    return "skip_nudge";
  }

  if (hasExactLocalPath(prompt) || isExternalOnlyPrompt(prompt)) {
    return "skip_nudge";
  }

  return "likely_orientation";
}

export function isNavigatorPromptGuidanceReady(facts: NavigatorPromptReadinessFacts): boolean {
  return (
    facts.repoResolved &&
    facts.selectedTools?.includes("navigator_locate") === true &&
    facts.coverage.total > 0 &&
    facts.coverage.indexed === facts.coverage.total &&
    facts.fullCrawlDone &&
    typeof facts.indexedHead === "string" &&
    facts.indexedHead.length > 0 &&
    typeof facts.currentHead === "string" &&
    facts.currentHead.length > 0 &&
    facts.indexedHead === facts.currentHead &&
    !facts.dirty &&
    !facts.workerFailed
  );
}

export function buildNavigatorPromptGuidance(args: BuildNavigatorPromptGuidanceArgs): string[] {
  if (!isNavigatorPromptGuidanceReady(args.readiness)) {
    return [];
  }

  const guidance: string[] = [];
  const persona = args.persona.trim();

  if (persona) {
    guidance.push(persona);
  }

  if (classifyNavigatorPrompt(args.prompt) === "likely_orientation") {
    guidance.push(NAVIGATOR_PROMPT_NUDGE);
  }

  return guidance;
}
