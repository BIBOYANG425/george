# trojans360 → George knowhow distillation (design)

Status: approved design, ready for implementation plan
Date: 2026-06-18
Owner: Bobby + Claude (CTO mode)

## Goal

Distill USC knowledge from [trojans360.com](https://www.trojans360.com) into
George's existing knowledge tables so he can answer more curated USC questions
with low latency, without inventing facts and without changing his retrieval
path. trojans360 is a student-run USC advice blog (Academics / Advice / Career /
Health & Wellness). It carries genuinely useful USC-specific nuggets (off-campus
scam avoidance, the food pantry, finals study spots) mixed with generic
college-advice and personal-reflection essays.

## Source analysis (recon, 2026-06-18)

- trojans360.com runs on **Squarespace**, not WordPress. Clean structured JSON
  is available by appending `?format=json-pretty` to any collection or item URL
  (returns title, body HTML, `publishOn`, categories, tags, `fullUrl`). This
  replaces fragile HTML scraping for the index + fetch phases.
- `robots.txt` is content-permissive: only `/config`, `/search`, `/account`,
  `/api/`, `/static/` are disallowed for all agents (AI bots included). Blog post
  paths are crawlable.
- Content shape is prose, closest to the WeChat-group case (unstructured text
  needing LLM distillation), not the catalogue case (already structured).

## Design decisions (settled in brainstorming)

1. **Trust model: blend into the existing tables with a `source` tag.** Distill
   straight into `freshman_faq` / `campus_knowledge` / `course_tips`, the same
   tables the WeChat pipeline writes, tagged `source='trojans360'`. (Chosen over
   a dedicated `external_knowhow` table for simplicity and pattern reuse.) A
   `source` column keeps provenance so George can attribute when relevant.
2. **Content scope: USC-specific + wellness, skip reflection.** The LLM triage
   step keeps USC-specific actionable nuggets AND generic-but-useful
   wellness/study tactics, and drops pure personal-reflection essays.

## Architecture: `scripts/ingest-trojans360.ts`

Reuses the proven `scripts/ingest-wechat.ts` shape (resumable, on-disk
checkpoints under `data/ingest/trojans360/`). Phases:

1. **index** — walk the blog collection(s) via `<collectionUrl>?format=json-pretty`
   with offset pagination → list of `{ itemId, fullUrl, title, publishOn,
   categories, tags }`.
2. **fetch** — pull each item's body HTML from the collection JSON, strip to
   plain text.
3. **triage** (LLM, batched) — classify each article: keep if `usc_specific` or
   `wellness_tactic`; drop if `reflection` or `noise`. Enforces the scope
   decision. Runs on the lightweight model (`callLightweightLLM`: Kimi
   `moonshot-v1-8k`, or Claude Haiku 4.5 fallback).
4. **extract** (LLM) — distill kept articles into rows: `faq` (Q/A),
   `campus_knowledge` (title/content), or `course_tip`. Output is **neutral
   factual nuggets, not trojans360's prose** — George re-voices at response time
   from his persona. This is also the copyright safeguard: we store distilled
   facts plus a source link, never republished text. Runs on Claude Sonnet 4.6
   (`getClaudeClient`).
5. **embed** — OpenAI `text-embedding-3-small` (1536-d) per extracted item.
6. **dedupe** — cosine distance < 0.15 against existing rows (incl. WeChat + seed)
   so trojans360 does not echo what seniors already said.
7. **insert** — upsert with `source='trojans360'`, `source_url`, `published_at`.
   Supports `--dry-run` and `--since=<date>`.

Division of labor matches the WeChat distiller exactly: Kimi/Haiku triage,
Sonnet 4.6 extract, OpenAI embed for dedupe, run manually by Bobby.

## Schema delta (cross-repo: authored in bia-admin)

Neither `freshman_faq`, `campus_knowledge`, nor `course_tips` has a `source`
column today, and `freshman_faq.category` has a CHECK that lacks `wellness`. The
migration:

- `ADD COLUMN source text, source_url text, published_at date` to all three
  tables. Backfill existing rows: WeChat → `'wechat'`, seed → `'seed'`.
- Extend the `freshman_faq` category CHECK to include `'wellness'`.
  (`campus_knowledge.category` is free-form — no change, that is how the catalogue
  added `usc_program`.)

Per the cross-repo rule, this migration is authored in
`bia-admin/supabase/migrations` first, then George reads the new columns.

## Retrieval & attribution

- Distilled rows ride George's **existing FTS-first retrieval path**
  (`searchWithFallback`: Postgres FTS via `websearch_to_tsquery`, ILIKE fallback,
  ~5 rows, one DB round-trip, no query-time embedding). No new retrieval
  mechanism, so "low latency" holds by construction.
- Add `source, source_url` to the `select` in `freshman-faq.ts` and
  `campus-knowledge.ts` so the tool returns provenance. George can then attribute
  blog-sourced answers (for example "Trojans360 上写过…") instead of presenting
  them as senior-verified, recovering a trust signal that the blend-in trades
  away.

## Research-informed decisions (deep-research, 2026-06-18)

A multi-source, adversarially-verified research pass validated and refined the
above:

- **FTS-first is appropriate, not a hack.** For short, entity-heavy factual
  corpora (course codes, building names, prices, acronyms), lexical/BM25 search
  is competitive with or beats general-purpose dense embeddings (T2-RAGBench:
  BM25 Recall@5 0.644 vs text-embedding-3-large 0.587). George's FTS + ILIKE
  acronym fallback maps directly onto "lexical wins exact-term matching."
- **Hybrid (FTS + vector via RRF, HNSW index) is the documented future upgrade,
  not v1.** Embeddings already sit in the tables unused at query time, so the
  upgrade is cheap later, and the gain is only about +5pp on this corpus type, so
  it does not justify v1 complexity. If vector retrieval is ever turned on,
  switch the index from `ivfflat` to `hnsw`.
- **Distill into atomic Q&A, do not chunk.** Short FAQ-style entries favor no
  chunking, which is exactly the pipeline's output.
- **Drop semantic query→answer caching.** Its headline numbers failed
  adversarial verification (hyped, not proven). Not in the design.
- **Anthropic prompt caching is a separate, real cost lever** for George's static
  system prompt (90% read discount), independent of trojans360. Cost-proven,
  latency-unproven. Tracked separately, not part of this spec.
- **Grounding via provenance** supports the `source`/`source_url` decision.
- **Single-shot retrieval (one tool call), not iterative agentic retrieval**,
  keeps latency down. Keep `freshman_faq` / `campus_knowledge` as plain tools.

## Evaluation gate

Before trojans360 content goes live to students, run a lightweight eval: a golden
set of about 30-50 real freshman questions with expected source rows, measuring
recall@5 plus a groundedness spot-check. This closes the eval gap the research
flagged and gives a number to trust before flipping it on.

## Freshness

One-shot resumable ingest now, with `--since=<date>` for manual incremental
re-runs as trojans360 publishes. No cron in v1 (YAGNI). The research found no
proven standard for re-ingest cadence, so the simple manual approach stands.

## Ethics / legal

trojans360 is a peer USC student org. robots.txt permits content crawling, and we
store distilled facts plus attribution rather than republishing prose. The
defensible path also includes a courtesy heads-up or partnership note to
`usctrojans360@gmail.com` before this goes live. That is a founder decision, not
a code blocker (see Open decisions).

## Not in scope (YAGNI)

- No cron / scheduled re-ingest in v1.
- No live vector retrieval (embeddings stay dedupe-only, as today).
- No images, no comments ingestion.
- No dedicated `external_knowhow` table (blend-in chosen).

## Open decisions for Bobby

1. **Migration home.** Confirm the `source`/`source_url`/`published_at` +
   `wellness` migration is authored in `bia-admin` per the cross-repo rule.
2. **Courtesy email.** Decide whether to send the heads-up/partnership note to
   trojans360 before launch, and whether to record that step as a pre-launch gate
   in the implementation plan.

## Implementation plan outline

1. (bia-admin) Schema migration: `source`/`source_url`/`published_at` columns +
   `wellness` category. Apply and verify.
2. `scripts/ingest-trojans360.ts`: index + fetch via Squarespace JSON, with
   checkpoints.
3. Triage + extract prompts (scope-enforcing classification; neutral-voice
   extraction with source/published_at tagging).
4. Embed + cosine dedupe against existing rows; insert with `--dry-run`/`--since`.
5. Add `source`/`source_url` to the knowledge tool `select`s; light prompt note so
   George attributes blog-sourced answers.
6. Golden-set eval (recall@5 + groundedness) before enabling for students.
