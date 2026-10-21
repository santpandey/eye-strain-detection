"""Local persistence for the CLI: the app's IndexedDB equivalent.

- Baseline: single JSON record at ~/.blinkwell/baseline.json (meta 'baseline').
- History:  one QuickCheckResult JSON per line at ~/.blinkwell/history.jsonl.

Only summary metrics are ever persisted — never frames or images. Set
BLINKWELL_HOME to relocate the directory (tests).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .baseline import contribute, empty_baseline, normalize_baseline


def data_dir() -> Path:
    env = os.environ.get("BLINKWELL_HOME")
    if env:
        return Path(env)
    new = Path.home() / ".blinkwell"
    old = Path.home() / ".eyefd"
    # One-time migration from the pre-rename location — keeps existing
    # history/baseline from installs before the blinkwell rename.
    if not new.exists() and old.is_dir():
        try:
            old.rename(new)
        except OSError:
            pass
    return new


def _baseline_path() -> Path:
    return data_dir() / "baseline.json"


def _history_path() -> Path:
    return data_dir() / "history.jsonl"


def get_baseline() -> dict:
    """The stored baseline; an empty record when none exists yet."""
    try:
        raw = json.loads(_baseline_path().read_text(encoding="utf-8"))
    except Exception:
        return empty_baseline()
    return normalize_baseline(raw)


def update_baseline(r: dict, base: dict | None = None) -> dict:
    """Fold a saved session into the baseline and persist it. Call only for
    sessions that were actually saved — never abstained (low-confidence) ones.
    Pass an already-fetched `base` to skip a redundant read. Returns the
    updated record."""
    nxt = contribute(base if base is not None else get_baseline(), r)
    p = _baseline_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(nxt), encoding="utf-8")
    return nxt


def reset_baseline() -> None:
    p = _baseline_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(empty_baseline()), encoding="utf-8")


def save_session(r: dict) -> None:
    """Append one result to history.jsonl."""
    p = _history_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(r) + "\n")


def list_sessions() -> list:
    """All saved results, newest first (startedAt desc — same as db.ts)."""
    try:
        rows = [
            json.loads(line)
            for line in _history_path().read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except Exception:
        return []
    rows.sort(key=lambda r: r.get("startedAt", ""), reverse=True)
    return rows
