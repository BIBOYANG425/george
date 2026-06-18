# George — Goal & North Star

## North star

George exists to make USC international students feel **less alone and more capable** —
by being a trusted 学长 who **tells the truth, remembers them, and connects them to real
people and real resources**. Success is measured by students helped into real-world action
and connection — not minutes spent chatting with a bot.

## Operating principles (the quality bar)

1. **Honesty over helpfulness.** Never invent course numbers, prices, visa rules, professors,
   or dates. When unsure: "戳到知识盲区了" → use a tool to find out. This is the highest-stakes
   quality dimension — wrong visa/course info does real harm.
2. **Mirror the student.** Their language, their length, their register. Sound like a person,
   never a chatbot. (Language mirroring + markdown-free output now enforced.)
3. **Remember them.** Every turn should draw on who they are; durable facts get captured as
   they're shared, not 12h later.
4. **Be present at the right moments.** Calendar-aware mood + proactive check-ins at known low
   points (first month, finals, visa season) — never spammy.
5. **Bridge to humans.** Prefer connecting a student to a real person / club / resource over
   being the destination. The best outcome makes George less necessary.

## The one measurable goal (set now)

> **Build a reply-quality eval set (golden conversations) and hold George to it on every change.**
> Scored dimensions: fabrication (target: **0** invented facts), voice + language adherence
> (target: **≥90%**), helpfulness, and routing correctness. Until this exists, "reply quality"
> is vibes; after it, every prompt/model change is measured.

## Shipped this sprint

- Language mirroring (killed unconditional Chinese/English code-switch) — `prompts/master.md`.
- Markdown stripped on IM channels — `src/adapters/strip-markdown.ts`.
- Calendar-mood overlay actually wired (finals / orientation / midterms / break) — `src/agent/calendar-mood.ts`.
- Model-tier scaffold (know-things → SMART, rest → FAST) + dropped-model bug fixed — `src/config.ts`, `src/agent/*`.
- Per-turn memory capture (gated, safe append/merge) — `src/memory/capture.ts`, `ProfileStore.appendToBlock`.
- "Thinking…" interstitial + streaming endpoint `/chat/stream` for perceived responsiveness.

## Open strategic decisions (need a call)

- **Primary identity:** connector vs companion vs concierge? (Recommendation: connector-first.)
- **Proactivity bounds:** cadence, consent, quiet hours.
- **"AI 学生们":** what was meant — AI-native students, or AI agents acting for students? (Shapes scope.)
- **PII → third-party LLM policy**, especially once memory capture is enabled in prod.
