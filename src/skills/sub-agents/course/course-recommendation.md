---
name: course-recommendation
description: Use when a student asks what class to take, for a fun/easy/interest-based course, or for a GE pick. Encodes the recommend_courses/ge_candidates-first order, RMP thresholds, and bullet formatting.
tier: sub-agent
sub_agent: course
tools: [recommend_courses, ge_candidates, get_rmp_ratings, search_ge_courses]
---

When a student asks "what class should I take" / "fun class" / interest-based recs:

1. Call `recommend_courses` FIRST. It returns real, current USC courses matched to
   the interest (department + number + title + why-it-fits). Name those actual
   courses with their numbers. This is NOT fabrication — the tool gives real data.
   NEVER hedge, refuse, say "I don't wanna throw fake course numbers," or punt the
   student to classes.usc.edu / the catalogue WITHOUT calling `recommend_courses`
   first. Only if the tool genuinely fails or returns nothing do you fall back.
2. Personalize from the USER PROFILE. Fold the student's major + standing + relevant
   interests into the `interests` string (e.g. "rising senior in ENST exploring ai +
   film"), and set `level` from their year (freshman/sophomore → lower, junior/senior
   → upper, grad → graduate). When relaying, connect picks back to who they are
   ("counts toward your ENST track"). Do NOT recommend as if they were anonymous.
3. Respect the recommender's ranking. `recommend_courses` returns a list already
   sorted by relevanceScore with matchReasons/aiReasoning. Lead with the top 1-2
   highest-scored courses and pass through their actual reasoning. Do NOT skip the
   top-ranked result to surface a more generic / "easier" course.

For "recommend an easy/good GE class" (or similar):

1. Call `ge_candidates` ONCE — it returns a fast, rating-ranked list of GE courses
   already enriched with each professor's RMP rating, difficulty, would-take-again,
   and open status. Do NOT chain `search_ge_courses` + `get_rmp_ratings`, and do NOT
   call `recommend_courses` for GE recs — those are slow.
2. PERSONALIZE: from the full list pick and order the best handful FOR THIS STUDENT
   using their profile. If they named a category, pass it; otherwise span categories.
3. Only fall back to `search_ge_courses` if `ge_candidates` returns nothing.

RMP thresholds (hard rules):

- WRIT 150: prefer professors at RMP 4.8+ with at least 10 ratings, then fall back to
  4.5+. WRIT-150 is the strictest — do not relax to the generic bar.
- Other courses: RMP > 4.0 is the default bar. Look at the prof rating before the
  class rating (section > course: the same course under different profs varies wildly).
- If NO professor in that course clears the threshold, surface the HIGHEST-rated
  available instead of refusing. Name it explicitly and give the trade-off:
  "这门最高也就 X.X，要不要等下学期 / 慎重". Never refuse silently.
- Never cite an RMP number without calling `get_rmp_ratings` first. If the tool fails,
  fall back to `get_course_reviews` or founder lore, but never cite a specific score
  that did not come from a successful tool call.

Formatting: when you name two or more courses, put each on its own line with a `•`
bullet, e.g. `• ENGL 299g "Intro to Poetry" w/ Theis (RMP 5.0/1.4)`. Keep the bullets
on consecutive lines with no blank line between them. Use the `•` character, never a
markdown `-` or `*` (those render as literal dashes in iMessage). A short lead-in and
short closing line around the bullet block are fine.

Avoid list (section-specific warnings): BUAD 280 with Sweeney ("考试一个半小时 200 道题")
is the canonical example — warn before recommending a known-brutal section.
