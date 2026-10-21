import { openDB, type IDBPDatabase } from 'idb';
import type { QuickCheckResult } from '../analysis/session';
import {
  contribute,
  emptyBaseline,
  normalizeBaseline,
  type BaselineStats,
} from '../analysis/baseline';

const DB_NAME = 'eye-fatigue';
const STORE = 'sessions';
/** Key-value store for app-level records (personal baseline, …). */
const META = 'meta';
const BASELINE_KEY = 'baseline';

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    // v2 adds the 'meta' store; 'sessions' is created only when absent so the
    // 1→2 upgrade leaves existing history untouched.
    dbPromise = openDB(DB_NAME, 2, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id' });
        }
        if (!d.objectStoreNames.contains(META)) {
          d.createObjectStore(META);
        }
      },
    });
  }
  return dbPromise;
}

export async function saveSession(r: QuickCheckResult): Promise<void> {
  await (await db()).put(STORE, r);
}

export async function listSessions(): Promise<QuickCheckResult[]> {
  const all = (await (await db()).getAll(STORE)) as QuickCheckResult[];
  return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function latestSession(): Promise<QuickCheckResult | null> {
  return (await listSessions())[0] ?? null;
}

export async function updateSession(r: QuickCheckResult): Promise<void> {
  await (await db()).put(STORE, r);
}

export async function clearAll(): Promise<void> {
  const d = await db();
  await Promise.all([d.clear(STORE), d.clear(META)]);
}

// --- Personal baseline (stored as a single meta record) ---

/** The stored baseline; an empty record when none exists yet. */
export async function getBaseline(): Promise<BaselineStats> {
  const raw = await (await db()).get(META, BASELINE_KEY);
  return normalizeBaseline(raw);
}

/**
 * Fold a saved session into the baseline and persist it. Call only for
 * sessions that were actually saved — never abstained (low-confidence) ones.
 * Pass an already-fetched `base` to skip a redundant read. Returns the
 * updated record.
 */
export async function updateBaseline(
  r: QuickCheckResult,
  base?: BaselineStats,
): Promise<BaselineStats> {
  const next = contribute(base ?? (await getBaseline()), r);
  await (await db()).put(META, next, BASELINE_KEY);
  return next;
}

export async function resetBaseline(): Promise<void> {
  await (await db()).put(META, emptyBaseline(), BASELINE_KEY);
}
