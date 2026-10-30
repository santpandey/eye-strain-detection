---
name: parity-check
description: Run after editing analysis-layer files in cli-rs (and cli/) — replay synthetic + diag traces through npm/cargo/python and confirm identical event lists and TP/FP/FN across all three implementations.
---

# Parity gate

After touching `cli-rs/src/{config,features,quality,blink,session,thresholds,
eval,baseline,score}.rs`, re-run BOTH:

```
npm run eval:trace -- tests/traces/synthetic.trace.json tests/traces/synthetic.labels.json
cargo run -p blinkwell -- trace tests/traces/synthetic.trace.json --labels tests/traces/synthetic.labels.json
```

and the same pair for `eval-data/diag-20261020_152808-chromium.json` +
`eval-data/20261020_152808.labels.json`. Confirm identical event lists and
TP/FP/FN.

Python parity check:

```
cli/.venv/bin/python -m blinkwell trace tests/traces/synthetic.trace.json --labels tests/traces/synthetic.labels.json
```

must reproduce `npm run eval:trace` event-for-event (verified F1-identical on
synthetic + two eval-data diag traces).

## Sync rules

- `cli-rs/src/config.rs` must stay synchronized with
  `src/lib/analysis/config.ts` and `cli/blinkwell/config.py` — the header
  comment says the same. Names match the TS (`PROM_START` = `promStart`).
- `cli/blinkwell/config.py` stays in sync with `src/lib/analysis/config.ts` —
  every CFG constant was copied verbatim.
- `cli-rs/tests/blink.rs` ports `tests/blink.test.ts`; keep new detector
  behaviors covered in both places.
