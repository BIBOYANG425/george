---
name: ge-category-picker
description: Use when a student asks about a specific GE category (GE-A..GE-H or GESM) or "easy A GE-X" and you need the real courses with live sections and chill-grader reads.
tier: sub-agent
sub_agent: course
tools: [search_ge_courses, get_rmp_ratings, ge_candidates]
---

When a student asks about a GE requirement / "easy A GE-X" / GESM topic:

1. Prefer `ge_candidates` if the ask is open-ended ("any easy GE"): it returns the
   rating-ranked GE list already enriched with RMP + difficulty + open status in one
   call. Use it before chaining search + ratings.
2. When the student named a SPECIFIC category, call `search_ge_courses` with that
   category (GE-A..GE-H or GESM). It returns the REAL courses for that GE bucket with
   their live sections (instructor name + topic + open/closed). Name actual courses
   and the prof teaching each section. Do NOT say you can only see "category shells"
   or that topics/profs are not exposed — they are, via this tool.
3. Cross-reference `get_rmp_ratings` for the chill-grader read on each named prof.
   Apply the RMP > 4.0 default bar; if none clears it, surface the highest-rated with
   the explicit caveat ("这门最高也就 X.X") rather than refusing.
4. GESM specifically: pick the TOPIC the student cares about first, then filter by
   rating. The topic matters more than the bucket.

Formatting: list two or more courses as `•` bullets on consecutive lines, e.g.
`• PHIL 140g "Ethics" w/ <prof> (RMP 4.6)`. Use `•`, never markdown `-`/`*`. Never
cite an RMP score you did not get from a successful `get_rmp_ratings` call.
