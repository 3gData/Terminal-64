// Fuzzy-match a spoken transcript against a set of AI session names.
// Normalizes snake_case / camelCase / kebab-case / PascalCase to lowercase space-separated
// tokens, then scores candidates by token overlap + Levenshtein distance.
// Returns the best-matching sessionId above threshold, or null.

export interface VoiceMatchableSession {
  id: string;
  name: string;
}

export function normalizeForMatch(input: string): string {
  if (!input) return "";
  return input
    // camelCase / PascalCase → insert space before capitals following a lowercase or digit
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // consecutive capitals then lower (e.g. "APIKey" → "API Key")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // snake_case, kebab-case, dots, slashes → spaces
    .replace(/[_\-./]+/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  const n = normalizeForMatch(s);
  return n ? n.split(" ") : [];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // classic DP, space-optimized to two rows
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,       // insertion
        prev[j] + 1,           // deletion
        prev[j - 1] + cost     // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function tokenOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hits = 0;
  for (const t of a) if (setB.has(t)) hits++;
  // Jaccard-ish: hits / max(|a|, |b|)
  return hits / Math.max(a.length, b.length);
}

/**
 * Score a transcript against a candidate session name.
 * Higher is better. Range roughly [0, 1].
 */
export function scoreMatch(transcript: string, candidate: string): number {
  const tNorm = normalizeForMatch(transcript);
  const cNorm = normalizeForMatch(candidate);
  if (!tNorm || !cNorm) return 0;

  // Exact normalized match dominates.
  if (tNorm === cNorm) return 1;

  // Substring bonus.
  const contains = cNorm.includes(tNorm) || tNorm.includes(cNorm) ? 0.85 : 0;

  const tTok = tokens(transcript);
  const cTok = tokens(candidate);
  const overlap = tokenOverlap(tTok, cTok);

  // Levenshtein similarity normalized to [0, 1].
  const maxLen = Math.max(tNorm.length, cNorm.length);
  const lev = maxLen === 0 ? 1 : 1 - levenshtein(tNorm, cNorm) / maxLen;

  // Weight: overlap matters most, substring next, levenshtein as tiebreaker.
  return Math.max(contains, overlap * 0.6 + lev * 0.4);
}

/**
 * Return the sessionId whose name best matches the transcript, or null if no
 * candidate clears the threshold. 0.35 is permissive enough to absorb
 * whisper misspellings ("planar" → "planner", "authenticate" → "auth
 * refactor") while still rejecting truly unrelated utterances.
 *
 * When there are very few sessions, also accept the top candidate
 * unconditionally if it's comfortably ahead of the runner-up — single-word
 * whisper transcripts of short session names can score below absolute
 * threshold but still be obviously the intended pick.
 */
export function matchSession(
  transcript: string,
  sessions: VoiceMatchableSession[],
  threshold = 0.35
): string | null {
  if (!transcript || !sessions.length) return null;
  let bestId: string | null = null;
  let bestScore = 0;
  let runnerScore = 0;
  for (const s of sessions) {
    if (!s.name) continue;
    const score = scoreMatch(transcript, s.name);
    if (score > bestScore) {
      runnerScore = bestScore;
      bestScore = score;
      bestId = s.id;
    } else if (score > runnerScore) {
      runnerScore = score;
    }
  }
  if (bestScore >= threshold) return bestId;
  // Clear-winner fallback: best is above 0.2 AND at least 2× the runner-up.
  if (bestScore >= 0.2 && bestScore >= runnerScore * 2) return bestId;
  return null;
}
