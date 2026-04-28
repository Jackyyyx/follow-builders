# Translation Prompt

The digest is produced directly in Simplified Chinese — translation is no
longer a separate post-processing step. This file documents the language
rules that the per-source prompts already follow, and is referenced by the
LLM as a fallback / sanity check.

## Language rules

- All prose is natural, fluent Mandarin Chinese (Simplified). It must read
  like it was originally written in Chinese, not translated from English.
- Keep the following in original English, untranslated:
  - People's names (Andrej Karpathy, Aaron Levie, ...)
  - Company / product / model names (Anthropic, Claude, Mistral, Voxtral,
    Replit, Box, Y Combinator, Latent Space, ...)
  - Twitter / X handles when they appear (but prefer omitting `@handle` in
    body prose; use the person's name instead)
  - URLs — never translate or modify URLs
  - Standard technical jargon: AI, LLM, GPU, TPU, API, MCP, RAG, agent,
    demo, token, prompt, fine-tuning, transformer, embedding, etc.
- Never use em-dashes (`—`) between Chinese characters. Use the regular
  Chinese punctuation (`，`、`。`、`：`、`；`).
- Numbers, dates, and units stay in standard form (e.g. `210 亿美元`,
  `30 分钟`, `2026 年 4 月`).

## Tone

- Professional but conversational — 像是一位懂行的朋友在跟你聊天.
- Analytical and third-person.
- No marketing speak, no "震惊" / "重磅" headlines.

## Structure preservation

- Keep the Markdown structure intact: `##` section headers, `###`
  per-item headers, `>` blockquote for the podcast bottom-line, `---`
  section dividers, and inline `[link](url)` citations.
- Citation blocks always use full-width Chinese parens: `（ ）`.
- One blank line between items, no extra blank lines.
