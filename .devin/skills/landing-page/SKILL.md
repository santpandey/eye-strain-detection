---
name: landing-page
description: Use when editing site/ (the public brochure) or any marketing/copy surface — conversion structure, copy rules, and this project's SEO checklist. Does NOT apply to the Svelte app UI in src/.
---

# Landing page work — project-adapted

Adapted from elayadesign/ai-design-skills `landing-page-design` (MIT),
stripped of its Tailwind/font/color mandates that conflict with this repo.

**Scope: `site/` and marketing copy only — never `src/` (the app UI has its
own design language).**

## Strategy

- One offer, one audience, one primary action. For this site the action is
  the install command — everything else supports it.
- Section order earns trust: promise → how it works → what it sees →
  commands → privacy → FAQ → footer.
- Copy rules: benefit-first, specific numbers over adjectives, plain words a
  non-tech user understands, no hype vocabulary ("revolutionary",
  "world-class"). Real names/numbers — no lorem ipsum or placeholder stats.
- **Preserve established terminology** — `eye strain`, `20-20-20`,
  `on-device`, `open-source` are SEO keywords AND honest product terms.
  Never de-hyphenate them.

## Project design rules (override any imported conventions)

- Hand-written CSS + existing tokens only — `--bg/--panel/--line/--ink/
  --txt/--mut/--acc*/--warn*/--mono/--sans` with `light-dark()` theming.
  No Tailwind, no new fonts, no new color systems; system font stack stays.
- New elements reuse existing patterns: `.pitem`, `.q`, `.sig`, `.tile`
  card styles; `.acc-*`/`--warn-*` for state colors.
- Motion: IntersectionObserver + transform/opacity transitions, all gated
  on `html.js` + `prefers-reduced-motion: no-preference`. No scroll
  listeners, no scroll-jacking, no libraries.
- Content must be fully visible and meaningful with JS disabled.

## SEO checklist (this project's, verified against the live site)

- Copy must contain the phrases people actually search — the page once had
  ZERO occurrences of "eye strain" while describing exactly that.
- Metadata: `<title>` + description in keyword language, canonical,
  og:/twitter: cards + og:image, `theme-color`, favicon.
- Structured data: `SoftwareApplication` + `FAQPage` JSON-LD; FAQ JSON-LD
  must match visible Q&A text exactly.
- `robots.txt`, `sitemap.xml`; `noindex` on utility endpoints
  (`/i`, `/i.ps1`, `/install.*` — installer scripts, not content).
- Thin content doesn't rank (~400 words): FAQ/real sections fix it.
- Semantic landmarks (`<main>`, `<nav>`), alt text, one H1.
- Internal links: repo, PyPI, docs. External links `rel="noopener"`.
- Honest claims only — privacy copy is verifiable against the code; never
  claim medical/clinical benefit (wellness guidance, not a diagnosis).
