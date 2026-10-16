/**
 * SynthOrg - Intelligent Fuzzy Search Engine
 * Supports:
 * - Unordered multi-token matching (e.g. "flash deepseek" matches "DeepSeek V4.1 Flash")
 * - Subsequence and gap-tolerant fuzzy matching (e.g. "sonet" matches "Sonnet", "gpt4o" matches "gpt-4o")
 * - Acronym matching (e.g. "c3s" matches "claude-3-sonnet")
 * - Field-weighted scoring (Name: 10, ID: 8, Provider: 5, Description: 2)
 */

class FuzzySearchEngine {
  constructor(options = {}) {
    this.keys = options.keys || [
      { name: 'name', weight: 10 },
      { name: 'id', weight: 8 },
      { name: 'provider', weight: 5 },
      { name: 'description', weight: 2 }
    ];
  }

  /**
   * Calculates similarity between a query token and a target text
   * Returns a score between 0 (no match) and 1 (exact match)
   */
  tokenScore(token, text) {
    if (!token || !text) return 0;
    const t = text.toLowerCase();
    const q = token.toLowerCase();

    // 1. Exact match
    if (t === q) return 1.0;

    // 2. Exact word boundary / prefix match
    if (t.startsWith(q)) return 0.95;
    const wordBoundary = t.indexOf(' ' + q);
    if (wordBoundary !== -1 || t.includes('/' + q) || t.includes('-' + q)) return 0.9;

    // 3. Substring match
    const subIdx = t.indexOf(q);
    if (subIdx !== -1) {
      // Earlier matches score higher
      return Math.max(0.65, 0.85 - (subIdx / t.length) * 0.2);
    }

    // 4. Subsequence fuzzy match (with gap penalties)
    let qIdx = 0;
    let gaps = 0;
    let consecutive = 0;
    let maxConsecutive = 0;
    let prevMatchedIdx = -1;

    for (let i = 0; i < t.length && qIdx < q.length; i++) {
      if (t[i] === q[qIdx]) {
        if (prevMatchedIdx !== -1) {
          const gap = i - prevMatchedIdx - 1;
          gaps += gap;
          if (gap === 0) {
            consecutive++;
            if (consecutive > maxConsecutive) maxConsecutive = consecutive;
          } else {
            consecutive = 0;
          }
        }
        prevMatchedIdx = i;
        qIdx++;
      }
    }

    // All characters of token were found in sequence
    if (qIdx === q.length) {
      const matchRatio = q.length / (q.length + gaps);
      return Math.max(0.4, matchRatio * 0.8);
    }

    // 5. Short typo tolerance (Levenshtein distance <= 1 for tokens >= 4 chars)
    if (q.length >= 4 && Math.abs(t.length - q.length) <= 2) {
      const dist = this.levenshtein(q, t.slice(0, q.length + 1));
      if (dist <= 1) return 0.6;
      if (dist <= 2 && q.length >= 6) return 0.45;
    }

    return 0;
  }

  levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[m][n];
  }

  /**
   * Searches a collection of items against query string
   * Polymorphic: accepts either search(items, query) or search(query, items)
   */
  search(arg1, arg2) {
    let items, query;
    if (Array.isArray(arg1)) {
      items = arg1;
      query = arg2;
    } else {
      query = arg1;
      items = arg2;
    }

    if (!items || !Array.isArray(items)) {
      return [];
    }

    if (!query || typeof query !== 'string' || !query.trim()) {
      return items;
    }

    // Split query into tokens (e.g. "flash deepseek" -> ["flash", "deepseek"])
    const queryTokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

    const scored = [];

    for (const item of items) {
      let totalItemScore = 0;
      let matchedTokensCount = 0;

      for (const qToken of queryTokens) {
        let bestTokenScore = 0;

        for (const keyConfig of this.keys) {
          const rawVal = item[keyConfig.name];
          if (!rawVal) continue;
          const textVal = String(rawVal);
          
          const s = this.tokenScore(qToken, textVal);
          const weighted = s * keyConfig.weight;
          if (weighted > bestTokenScore) {
            bestTokenScore = weighted;
          }
        }

        if (bestTokenScore > 0) {
          matchedTokensCount++;
          totalItemScore += bestTokenScore;
        }
      }

      // All query tokens must match something in the item
      if (matchedTokensCount === queryTokens.length) {
        scored.push({ item, score: totalItemScore });
      }
    }

    // Sort descending by relevance score
    scored.sort((a, b) => b.score - a.score);

    return scored.map(s => s.item);
  }
}

window.FuzzySearchEngine = FuzzySearchEngine;
window.fuzzyEngine = new FuzzySearchEngine();
