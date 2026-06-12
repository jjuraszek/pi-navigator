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
  enablePersona: boolean;
  enableNudge: boolean;
}

export const NAVIGATOR_PROMPT_NUDGE =
  "This request likely needs repo orientation. If no exact path is already known, call `navigator_locate` once before `rg`/`find`/`read`.";

export const STRONG_COVERAGE_THRESHOLD = 0.9;
export const NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX = "navigator is available; the index is still building";
export const NAVIGATOR_BOOT_CAVEAT =
  "If a navigator tool reports it is still booting, retry once before falling back to rg/fd.";
export const NAVIGATOR_LAG_CAVEAT =
  "Navigator's ranking may lag recent edits - verify candidates with `read` or `navigator_slice` before relying on them.";

function directiveTier(facts: NavigatorPromptReadinessFacts): "strong" | "weak" {
  const ratio = facts.coverage.total === 0 ? 0 : facts.coverage.indexed / facts.coverage.total;
  return ratio >= STRONG_COVERAGE_THRESHOLD && facts.fullCrawlDone ? "strong" : "weak";
}

function weakDirective(coverage: { total: number; indexed: number }): string {
  const pct = coverage.total === 0 ? 0 : Math.round((coverage.indexed / coverage.total) * 100);
  return `${NAVIGATOR_PROMPT_NUDGE_WEAK_PREFIX} (${pct}% indexed) - try \`navigator_locate\` first and fall back to \`rg\`/\`fd\` if results look thin.`;
}

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

// Persona tier gate: fires whenever the index is merely usable (at least one file
// indexed, worker alive, tool selected). NOT gated on freshness — dirty/partial/
// behind-HEAD repos are the exact case where always-on orientation is most needed.
export function personaUsable(facts: NavigatorPromptReadinessFacts): boolean {
  return (
    facts.repoResolved &&
    facts.selectedTools?.includes("navigator_locate") === true &&
    facts.coverage.indexed > 0 &&
    !facts.workerFailed
  );
}

export function buildNavigatorPromptGuidance(args: BuildNavigatorPromptGuidanceArgs): string[] {
  const guidance: string[] = [];
  const persona = args.persona.trim();
  const facts = args.readiness;

  if (args.enablePersona && persona && personaUsable(facts)) {
    guidance.push(persona);
  }

  const directiveEligible =
    args.enableNudge &&
    facts.repoResolved &&
    facts.selectedTools?.includes("navigator_locate") === true &&
    !facts.workerFailed &&
    classifyNavigatorPrompt(args.prompt) === "likely_orientation";

  if (directiveEligible) {
    if (directiveTier(facts) === "strong") {
      guidance.push(NAVIGATOR_PROMPT_NUDGE);
    } else {
      guidance.push(weakDirective(facts.coverage));
    }

    // Caveats only alongside a directive.
    if (facts.coverage.indexed === 0) {
      guidance.push(NAVIGATOR_BOOT_CAVEAT);
    }
    if (facts.dirty || (facts.indexedHead && facts.currentHead && facts.indexedHead !== facts.currentHead)) {
      guidance.push(NAVIGATOR_LAG_CAVEAT);
    }
  }

  return guidance;
}
