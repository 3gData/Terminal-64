//! Voice intent parser.
//!
//! Takes raw transcript text from the command STT (Moonshine) and classifies
//! it into a `VoiceIntent`. The grammar is deliberately tiny and forgiving:
//! strip a leading "jarvis" prefix, then match keyword stems. Anything else
//! becomes a `SelectSession { query }` when we're in IDLE state.

use crate::types::VoiceIntent;

/// Words that trigger Send.
const SEND_WORDS: &[&str] = &["send", "submit", "go", "fire", "ship", "sendit"];

/// Words that trigger Exit.
const EXIT_WORDS: &[&str] = &[
    "exit",
    "cancel",
    "nevermind",
    "never",
    "stop",
    "abort",
    "quit",
    "scratch",
];

/// Words that trigger Rewrite.
const REWRITE_WORDS: &[&str] = &["rewrite", "rephrase", "fix", "cleanup", "clean", "polish"];

/// Multi-word phrases that trigger Rewrite (checked before single-word pass).
const REWRITE_PHRASES: &[&str] = &["fix that", "clean up", "clean that up", "fix it"];

/// Normalise free-form voice text: lowercase, strip punctuation, collapse whitespace,
/// strip a leading "jarvis" (or "hey jarvis") address if present.
pub fn normalize(text: &str) -> String {
    let lower = text.to_lowercase();
    let cleaned: String = lower
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' { c } else { ' ' })
        .collect();
    let collapsed: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");

    // Strip leading "jarvis" / "hey jarvis" / "ok jarvis" address.
    let trimmed = collapsed.as_str();
    let trimmed = strip_prefix_word(trimmed, "hey");
    let trimmed = strip_prefix_word(trimmed, "ok");
    let trimmed = strip_prefix_word(trimmed, "okay");
    let trimmed = strip_prefix_word(trimmed, "yo");
    let trimmed = strip_prefix_word(trimmed, "jarvis");

    trimmed.trim().to_string()
}

fn strip_prefix_word<'a>(s: &'a str, word: &str) -> &'a str {
    let s = s.trim_start();
    if let Some(rest) = s.strip_prefix(word) {
        match rest.chars().next() {
            None => rest,
            Some(c) if !c.is_alphanumeric() => rest.trim_start(),
            _ => s,
        }
    } else {
        s
    }
}

/// Classify a normalised command transcript.
///
/// Returns `None` for empty input. Otherwise the classifier returns the matched
/// control intent, or falls back to `SelectSession { query }` carrying the
/// original (normalised, minus "jarvis") text so the caller can fuzzy-match
/// against session names.
pub fn classify(raw: &str) -> Option<VoiceIntent> {
    let norm = normalize(raw);
    if norm.is_empty() {
        return None;
    }

    // Phrase-level checks first (two-word idioms).
    for phrase in REWRITE_PHRASES {
        if norm == *phrase || norm.starts_with(&format!("{} ", phrase)) {
            return Some(VoiceIntent::rewrite());
        }
    }

    // Command intents fire ONLY on:
    //   - a single-token utterance that matches a command ("send"), OR
    //   - a 2-token utterance where the first is a command and the 2nd
    //     is a known filler ("send it", "stop now").
    // Any other multi-token input is treated as a session-name query.
    // Previously we allowed "any token matches in a ≤2 token utterance",
    // which turned session names like "docs rewrite" into Rewrite intents
    // and "go build" into Send, making SelectSession nearly unusable.
    const FILLER: &[&str] = &["it", "that", "this", "now", "please", "pls", "sir"];
    let tokens: Vec<&str> = norm.split_whitespace().collect();
    let first = tokens.first().copied().unwrap_or("");
    let is_command_shape = tokens.len() == 1
        || (tokens.len() == 2 && FILLER.contains(&tokens[1]));
    if is_command_shape {
        if matches_any(first, SEND_WORDS) {
            return Some(VoiceIntent::send());
        }
        if matches_any(first, EXIT_WORDS) {
            return Some(VoiceIntent::exit());
        }
        if matches_any(first, REWRITE_WORDS) {
            return Some(VoiceIntent::rewrite());
        }
    }

    Some(VoiceIntent::select_session(norm))
}

fn matches_any(token: &str, candidates: &[&str]) -> bool {
    candidates.iter().any(|c| stem_match(token, c))
}

/// Lightweight stem match: equal, or the token is a simple morphological variant
/// (trailing s / ed / ing, optional doubled final consonant) of the candidate.
/// Handles "sends", "cancelled" (British double-l), "rewriting" without pulling
/// in a real stemmer.
fn stem_match(token: &str, candidate: &str) -> bool {
    if token == candidate {
        return true;
    }
    const SUFFIXES: &[&str] = &["s", "es", "ed", "d", "ing", "er"];

    if let Some(rest) = token.strip_prefix(candidate) {
        if SUFFIXES.contains(&rest) {
            return true;
        }
    }
    // Silent-e drop: "rewrite" + "ing" → "rewriting".
    if let Some(stem) = candidate.strip_suffix('e') {
        if let Some(rest) = token.strip_prefix(stem) {
            if SUFFIXES.contains(&rest) {
                return true;
            }
        }
    }
    // Doubled final consonant (cancel → cancelled).
    if let Some(last) = candidate.chars().last() {
        if last.is_alphabetic() {
            let doubled = format!("{}{}", candidate, last);
            if let Some(rest) = token.strip_prefix(&doubled) {
                if SUFFIXES.contains(&rest) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::types::VoiceIntentKind;

    fn kind(intent: &VoiceIntent) -> &'static str {
        match intent.kind {
            VoiceIntentKind::Send => "send",
            VoiceIntentKind::Exit => "exit",
            VoiceIntentKind::Rewrite => "rewrite",
            VoiceIntentKind::SelectSession => "select",
            VoiceIntentKind::Dictation => "dictation",
        }
    }

    #[test]
    fn table_send() {
        for input in [
            "send",
            "Send.",
            "SEND!",
            "send it",
            "submit",
            "submits",
            "go",
            "fire",
            "ship",
            "jarvis send",
            "hey jarvis send",
            "Jarvis, submit.",
        ] {
            let got = classify(input).unwrap_or_else(|| panic!("none for {:?}", input));
            assert_eq!(kind(&got), "send", "input={:?}", input);
        }
    }

    #[test]
    fn table_exit() {
        for input in [
            "exit",
            "cancel",
            "cancelled",
            "cancels",
            "nevermind",
            "stop",
            "abort",
            "quit",
            "jarvis cancel",
            "hey jarvis stop",
            "scratch",
        ] {
            let got = classify(input).unwrap_or_else(|| panic!("none for {:?}", input));
            assert_eq!(kind(&got), "exit", "input={:?}", input);
        }
    }

    #[test]
    fn table_rewrite() {
        for input in [
            "rewrite",
            "rewrites",
            "rewriting",
            "rephrase",
            "fix that",
            "clean up",
            "clean that up",
            "fix it",
            "jarvis rewrite",
            "polish",
        ] {
            let got = classify(input).unwrap_or_else(|| panic!("none for {:?}", input));
            assert_eq!(kind(&got), "rewrite", "input={:?}", input);
        }
    }

    #[test]
    fn table_select_session() {
        let cases: &[(&str, &str)] = &[
            ("jarvis switch to planner", "switch to planner"),
            ("open the deploy agent", "open the deploy agent"),
            ("hey jarvis open build session", "open build session"),
            ("planner", "planner"),
        ];
        for (input, want_q) in cases {
            let got = classify(input).unwrap_or_else(|| panic!("none for {:?}", input));
            assert_eq!(got.kind, VoiceIntentKind::SelectSession, "input={:?}", input);
            assert_eq!(
                got.payload.as_deref(),
                Some(*want_q),
                "input={:?}",
                input
            );
        }
    }

    #[test]
    fn empty_returns_none() {
        assert!(classify("").is_none());
        assert!(classify("   ").is_none());
        assert!(classify("jarvis").is_none());
        assert!(classify("hey jarvis").is_none());
    }

    #[test]
    fn embedded_send_not_triggered_in_long_phrase() {
        // 3+ tokens where "send" is not first → should fall through to select.
        let got = classify("tell bob to send over the diff").unwrap();
        assert_eq!(kind(&got), "select");
    }

    #[test]
    fn punctuation_stripped() {
        assert_eq!(
            kind(&classify("Send!!!").unwrap()),
            "send",
            "bangs must not defeat match"
        );
        assert_eq!(
            kind(&classify("cancel.").unwrap()),
            "exit",
            "periods must not defeat match"
        );
    }

    #[test]
    fn normalize_strips_jarvis_prefix_only_once_per_address() {
        assert_eq!(normalize("hey jarvis send it"), "send it");
        assert_eq!(normalize("Jarvis, send."), "send");
        assert_eq!(normalize("ok jarvis rewrite"), "rewrite");
        // Does not eat "jarvis" mid-sentence.
        assert_eq!(normalize("tell jarvis something"), "tell jarvis something");
    }
}
