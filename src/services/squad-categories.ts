// The postable 找搭子 categories. The DB CHECK also allows 约会, but george never
// posts romantic 局 (platonic-only policy), so 约会 is excluded here.
export const SQUAD_CATEGORIES = ['拼车', '自习', '健身', '游戏', '其它'] as const;
export type SquadCategory = typeof SQUAD_CATEGORIES[number];

// Normalize a model/user-supplied category to a valid postable one.
//  - exact enum match (minus 约会) → that category
//  - 约会 or an obviously romantic ask → { rejected: 'romantic' }
//  - anything else (unknown/unmappable) → '其它'
export function normalizeSquadCategory(raw: string): SquadCategory | { rejected: 'romantic' } {
  const trimmed = raw.trim();

  // Check for romantic/date category
  if (trimmed === '约会') {
    return { rejected: 'romantic' };
  }

  // Check for exact match in postable categories
  if ((SQUAD_CATEGORIES as readonly string[]).includes(trimmed)) {
    return trimmed as SquadCategory;
  }

  // Anything else maps to 其它
  return '其它';
}
