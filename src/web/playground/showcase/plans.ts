/**
 * The two plan versions of the session "Rate-Limiting für /v2/connections" (WP-68): v1 was sent
 * back with feedback, v2 waits for approval. German text, code and identifiers in English.
 */

/** Plan file of the conversation (an invented account; only the tail is shown). */
export const PLAN_FILE = 'C:\\Users\\jonas\\.claude\\plans\\steady-crimson-heron.md';

export const PLAN_V1 = [
  '# Rate-Limiting für /v2/connections',
  '',
  '## Ziel',
  'Pro API-Key höchstens 60 Anfragen pro Minute auf `/v2/connections`, darüber `429 Too Many Requests`.',
  '',
  '## Schritte',
  '1. **Fixed Window** in `app/core/rate_limit.py`: `INCR rl:{api_key}:{minute}` mit `EXPIRE 60`.',
  '2. **Dependency** `rate_limit` neben `require_api_key` im Router `app/routers/connections.py`.',
  '3. **Tests** mit `fakeredis` in `tests/test_rate_limit.py`.',
  '4. `pytest` und `ruff check` laufen lassen.',
  '',
].join('\n');

export const PLAN_V2 = [
  '# Rate-Limiting für /v2/connections',
  '',
  '## Ziel',
  'Pro API-Key ein Limit je Tarif (Standard: 60 Anfragen pro Minute) auf `/v2/connections`.',
  'Darüber antwortet die API mit `429 Too Many Requests` und `Retry-After`.',
  '',
  '## Schritte',
  '1. **Sliding Window** in `app/core/rate_limit.py` – ein Sorted Set je Key, atomar per Lua-Skript:',
  '   ```python',
  '   async def hit(redis: Redis, key: str, limit: int):',
  '       now = time.time()',
  '       count, oldest = await SLIDING_WINDOW(',
  '           keys=[f"rl:{key}"], args=[now, WINDOW, limit])',
  '       retry_after = max(1, ceil(oldest + WINDOW - now))',
  '       return RateLimit(count <= limit, retry_after)',
  '   ```',
  '2. **Limits aus der Datenbank:** Spalte `requests_per_minute` in `api_plans` (Alembic-Migration',
  '   `0042_plan_rate_limits`), im Prozess 5 Minuten gecacht.',
  '3. **Dependency** `enforce_rate_limit` im Router `app/routers/connections.py`; jede Antwort bekommt',
  '   `X-RateLimit-Remaining`, eine 429 zusätzlich `Retry-After`.',
  '4. **Tests** in `tests/test_rate_limit.py` mit `fakeredis`: Grenze, `Retry-After`, zwei Keys unabhängig.',
  '5. **Rollout** hinter dem Flag `RATE_LIMIT_V2`: erst Staging, nach einem Tag Produktion.',
  '6. `pytest` und `ruff check` laufen lassen.',
  '',
  '## Nicht Teil des Plans',
  '- Limits für `/v1` – die Version wird im März abgeschaltet.',
  '- Eigene Limits je Endpunkt; vorerst gilt eines für die ganze Route.',
  '',
].join('\n');
