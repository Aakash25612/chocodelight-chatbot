/**
 * Detect product / item fragments in chat messages so we don't
 * mis-route them as customer names (e.g. "MUSTARD CAKE 50 KGS [QNT]").
 */

export function looksLikeProductQuery(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || t.length < 2) return false;

  if (/\[[^\]]+\]/.test(t)) return true;
  if (
    /\b\d+(\.\d+)?\s*(kgs?|kg|ltr|ltrs?|litre|liter|ml|gms?|grams?|g|pcs?|pkt|pkts?|qnt|bag|bags|tin|tins|jar|jars|bottle|bottles|pouch|pouches|tina)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(mustard\s+cake|mustard\s+oil|rapeseed|tori\s+pina|chocolate\s+dip|bigul|gyan)\b/.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(oil|cake|dip|chocolate|syrup|pouch|jar|bottle|tin)\b/.test(t) &&
    /\b(mustard|bigul|gyan|chocolate|choco|cocoa|rapeseed)\b/.test(t)
  ) {
    return true;
  }
  return false;
}

/** Strip filler words from a product-sales / sauda product fragment. */
export function cleanProductQueryFragment(text: string): string {
  return text
    .replace(/\b(average|avg)\s+(unit\s+)?price\b/gi, " ")
    .replace(/\b(unit\s+)?price\b/gi, " ")
    .replace(
      /\b(tell|show|give|get|list|check|what(?:'s| is)?|his|her|their|the|please|pls)\b/gi,
      " ",
    )
    .replace(
      /\b(pending\s+sauda|sauda\s+pending|pending\s+(sales\s+)?orders?|unshipped)\b/gi,
      " ",
    )
    .replace(/\bsauda\b/gi, " ")
    .replace(/\b(sale|sales|sold|invoiced)\b/gi, " ")
    .replace(/\b(of|for|from|about|in|with|and)\b/gi, " ")
    .replace(/[?!.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
