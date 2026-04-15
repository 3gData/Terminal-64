import { useState, useRef, useCallback, useEffect } from "react";
import { vectorSearch } from "../lib/tauriApi";
import type { VectorSearchResult } from "../lib/types";

/**
 * Debounced semantic search hook backed by sqlite-vec.
 * Replaces the duplicated pattern across ClaudeDialog, SkillDialog, and FileTree.
 */
export function useSemanticSearch(table: string, topK: number = 10) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VectorSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback((value: string) => {
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);
    if (!value.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(() => {
      vectorSearch(table, value.trim(), topK)
        .then((r) => { setResults(r); setSearching(false); })
        .catch(() => { setResults([]); setSearching(false); });
    }, 300);
  }, [table, topK]);

  const clear = useCallback(() => {
    setQuery("");
    setResults([]);
    setSearching(false);
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  return { query, results, searching, search, clear };
}
