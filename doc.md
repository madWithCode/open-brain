# Telegram → Supabase AI Memory System Setup Guide

This document provides a **clear, end-to-end setup process** for building a Telegram-based AI memory capture system using:

- Telegram Bot (input interface + `/search` command)
- Supabase Edge Functions (backend processing)
- PostgreSQL + pgvector (semantic storage)
- OpenAI embeddings (vector generation) + GPT-4o-mini (answer synthesis)

The architecture is optimized for **Supabase free tier usage** and designed to be reliable, scalable, and agent-ready.

---

# System Architecture Overview

```
Telegram message
    ↓
telegram-webhook (Edge Function)
    ├─ /search <query>
    │      ↓
    │  Generate query embedding (OpenAI text-embedding-3-small)
    │      ↓
    │  match_memories() — cosine similarity search (threshold 0.3, up to 100)
    │      ↓
    │  Sort by capture time (chronological)
    │      ↓
    │  Reply as bullet points via Telegram sendMessage
    │
    └─ regular message
           ↓
       Insert raw memory + store chat metadata
           ↓
       Queue embedding job
           ↓
       process-embeddings (Edge Function, runs every minute via Cron)
           ↓
       Generate embeddings (OpenAI text-embedding-3-small)
           ↓
       Store enriched memory + mark job completed
```

---

# Project File Structure

```
supabase/
  migrations/
    001_initial_setup.sql       ← all DB setup (run once in SQL Editor)
  functions/
    telegram-webhook/
      index.ts                  ← receives Telegram messages
    process-embeddings/
      index.ts                  ← generates + stores embeddings
.env.example                    ← required secrets reference
```

---

# Prerequisites

Ensure you already have:

- Supabase project created
- OpenAI account + API key
- Telegram installed
- Ability to create Edge Functions

---

# STEP 1 — Run Migration SQL

Open **Supabase SQL Editor** and run the full contents of:

```
supabase/migrations/001_initial_setup.sql
```

This single file handles all of Steps 2–6 below. You can run each block individually or all at once.

---

# STEP 2 — Enable pgvector Extension

```sql
create extension if not exists vector;
```

---

# STEP 3 — Create Dedicated Schema

```sql
create schema if not exists brain;
```

This isolates AI memory data from other application tables.

---

# STEP 4 — Create Memories Table

```sql
create table if not exists brain.memories (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  category text,
  metadata jsonb default '{}',
  embedding vector(1536),
  source text default 'telegram',
  created_at timestamp default now()
);
```

Stores:

- original message
- classification category
- structured metadata (chat_id, user_id, username)
- 1536-dimension embedding vector

---

# STEP 5 — Create Embedding Job Queue Table

```sql
create table if not exists brain.embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid references brain.memories(id) on delete cascade,
  status text default 'pending',
  retry_count int default 0,
  created_at timestamp default now()
);
```

- `status` values: `pending` → `completed` or `failed`
- `retry_count` increments on failure; job is marked `failed` after 3 attempts
- `on delete cascade` cleans up jobs if the parent memory is deleted

---

# STEP 6 — Disable Row Level Security (Temporary Setup Mode)

```sql
alter table brain.memories disable row level security;
alter table brain.embedding_jobs disable row level security;
```

Later you can re-enable RLS with policies.

---

# STEP 7 — Grant Schema Access to REST API

```sql
grant usage on schema brain to anon;
grant usage on schema brain to service_role;
grant all on brain.memories to anon;
grant all on brain.embedding_jobs to anon;
grant all on brain.memories to service_role;
grant all on brain.embedding_jobs to service_role;
```

Required for Edge Functions using the anon key.

---

# STEP 8 — Create Semantic Search Function

```sql
create or replace function brain.match_memories(
  query_embedding vector(1536),
  match_threshold float default 0.7,
  match_count int default 10
)
returns table (
  id uuid,
  content text,
  category text,
  metadata jsonb,
  similarity float
)
language sql stable
as $$
  select
    m.id,
    m.content,
    m.category,
    m.metadata,
    1 - (m.embedding <=> query_embedding) as similarity
  from brain.memories m
  where m.embedding is not null
    and 1 - (m.embedding <=> query_embedding) > match_threshold
  order by m.embedding <=> query_embedding
  limit match_count;
$$;
```

Used later for semantic search queries against stored memories.

---

# STEP 9 — Expose Brain Schema via PostgREST (MANUAL STEP)

> **This step is required for Edge Functions to access the `brain` schema via the REST API.**

Go to:

```
Supabase Dashboard → Settings → API → Exposed schemas
```

Add `brain` to the list alongside `public`. Save changes.

**Why this matters:** Supabase's REST API (PostgREST) only serves tables from schemas listed here. Without this, all `/rest/v1/` requests to brain tables will return 404. The Edge Functions use the `Content-Profile: brain` header to target this schema — but the schema must be exposed first.

---

# STEP 10 — Create Telegram Bot

Open Telegram and search:

```
@BotFather
```

Run:

```
/newbot
```

Copy the generated:

```
BOT_TOKEN
```

Example format:

```
123456789:AAExampleToken
```

---

# STEP 11 — Store Required Secrets in Supabase

Go to:

```
Project Settings → Edge Functions → Secrets
```

Add:

```
SUPABASE_URL             ← Project Settings → API → Project URL
SUPABASE_ANON_KEY        ← Project Settings → API → anon key
OPENAI_API_KEY           ← platform.openai.com → API Keys
TELEGRAM_BOT_TOKEN       ← from @BotFather → /mybots → API Token
TELEGRAM_SECRET_TOKEN    ← any random string (openssl rand -hex 32)
```

`TELEGRAM_SECRET_TOKEN` is sent by Telegram with every webhook request and verified by the Edge Function to reject forged requests.

---

# STEP 12 — Create telegram-webhook Edge Function

Create function named:

```
telegram-webhook
```

Paste the contents of:

```
supabase/functions/telegram-webhook/index.ts
```

**Key implementation notes:**

- Uses `Content-Profile: brain` header so PostgREST routes to the `brain` schema (not `brain.memories` in the URL — that does not work)
- Stores `chat_id`, `user_id`, and `username` in the `metadata` jsonb column
- Verifies `X-Telegram-Bot-Api-Secret-Token` header if `TELEGRAM_SECRET_TOKEN` secret is set
- Non-text messages (photos, stickers, etc.) return `200 OK` silently — Telegram requires a 200 response or it will retry
- Handles `/search <query>` command: generates a query embedding, calls `match_memories()` with threshold `0.3` and up to 100 results sorted by capture time, and replies with each matching memory as a bullet point

Deploy function.

---

# STEP 13 — Register Telegram Webhook

Open browser (replace placeholders):

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<PROJECT_ID>.supabase.co/functions/v1/telegram-webhook&secret_token=<TELEGRAM_SECRET_TOKEN>
```

Expected response:

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

> If you set `TELEGRAM_SECRET_TOKEN`, include `&secret_token=<your-token>` in the URL above so Telegram sends the header with each request.

---

# STEP 14 — Test Message Capture

Send a message to your Telegram bot:

```
Test memory capture
```

Check table in Supabase Table Editor:

```
brain.memories
```

A new row should appear with `content` populated and `embedding` as `null` (not yet processed).

---

# STEP 15 — Create process-embeddings Edge Function

Create function:

```
process-embeddings
```

Paste the contents of:

```
supabase/functions/process-embeddings/index.ts
```

**Key implementation notes:**

- Fetches up to 5 pending jobs per invocation (batch size configurable via `BATCH_SIZE`)
- Uses `Promise.allSettled` so one failed job does not block others in the batch
- On failure: increments `retry_count`; marks job as `failed` after 3 attempts (configurable via `MAX_RETRIES`)
- GET requests use `Accept-Profile: brain` and write requests (PATCH/POST) use `Content-Profile: brain` — PostgREST requires different headers per operation type or it defaults to the `public` schema
- Returns JSON: `{ "processed": N, "failed": N }`

Deploy function.

---

# STEP 16 — Trigger Embedding Worker

Invoke manually by opening in browser or via curl:

```
https://<PROJECT_ID>.supabase.co/functions/v1/process-embeddings
```

Expected response:

```json
{"processed": 1, "failed": 0}
```

Check `brain.memories` — the `embedding` column should now be populated and `embedding_jobs.status` should show `completed`.

> If you see `{"processed": 0, "failed": 1}` or an error, check:
> - `OPENAI_API_KEY` is set under Project Settings → Edge Functions → Secrets
> - Edge Function logs: Dashboard → Edge Functions → process-embeddings → Logs

---

# STEP 17 — Automate Embedding Worker with Supabase Cron

Triggering manually works for testing, but in production you want the worker to run automatically after every new message.

Supabase has a built-in Cron integration — no SQL or extensions required:

```
Supabase Dashboard → Integrations → Cron → Create a new job
```

Set it up with:

- **Name:** `process-embeddings`
- **Schedule:** `* * * * *` (every minute)
- **Type:** Edge Function
- **Function:** `process-embeddings`

Save. The worker will now run every minute and process any pending embedding jobs automatically.

### Fixing 401 Unauthorized from Cron

The Supabase Cron integration does not automatically send an auth token to Edge Functions. Fix with one of these options:

**Option A — Disable JWT verification on the function (recommended for internal workers)**

```
Supabase Dashboard → Edge Functions → process-embeddings → Settings → Verify JWT → Off
```

Since `process-embeddings` is only triggered internally and never called by end users, disabling JWT verification is safe.

**Option B — Add Authorization header in the Cron job**

Edit the cron job and add a request header:

```
Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
```

The service role key is found under:

```
Supabase Dashboard → Project Settings → API → service_role key
```

---

# Expected Final Result

After sending a Telegram message:

```
Ravi suggested offline attendance sync
```

Database row contains:

```
content   → "Ravi suggested offline attendance sync"
embedding → [0.023, -0.041, ...] (1536 floats)
metadata  → { "chat_id": 123, "user_id": 456, "username": "ravi" }
category  → null (ready for classification)
```

Your AI memory capture pipeline is now fully operational with semantic search and AI-synthesized answers.

---

# STEP 18 — Using the /search Command

Once the system is running, send a `/search` query to your bot from Telegram:

```
/search attendance sync
/search what did Ravi suggest
/search project deadline notes
```

**What happens:**

1. The bot generates an embedding for your query
2. `match_memories()` finds all semantically similar memories (cosine similarity ≥ 0.3, up to 100 results)
3. Results are sorted by the time you captured them (oldest first)
4. The bot replies with each matching memory as a bullet point

**Example:**

Query: `/search attendance sync`

Reply:
```
2 memories found for "attendance sync":

• Ravi suggested offline attendance sync
• Need to queue sync events locally and push when connectivity is restored
```

If no memories match the threshold, the bot replies:
```
No memories found for: "attendance sync"

Try rephrasing — search finds meaning, not exact words.
```

> **Note:** Search uses semantic similarity, not keyword matching. "meeting about database" may match a memory that says "discussed schema design with the team" — even without shared words.

---

# Fixes Applied vs Original Design

| Issue | Original | Fixed |
|---|---|---|
| Custom schema REST access | `/rest/v1/brain.memories` (broken) | `/rest/v1/memories` + `Content-Profile: brain` header |
| Auth headers on memory fetch | Missing in `process-embeddings` | Added to all requests |
| Failed job handling | Jobs stuck as `pending` forever | Retry count + `failed` status after 3 attempts |
| Webhook security | No verification | `X-Telegram-Bot-Api-Secret-Token` check |
| Non-text Telegram updates | Returned error | Returns `200 OK` silently |
| Cascade delete | No `on delete cascade` | Added to `embedding_jobs.memory_id` |
| Semantic search | Not included | `brain.match_memories()` function added |
| Search threshold too strict | `match_threshold: 0.5` silently dropped real matches | Lowered to `0.3`, cap raised to 100 |
| Search result format | Numbered list with similarity scores | Bullet points in chronological capture order |

---

# Next Recommended Improvements

Optional upgrades:

- Metadata extraction with GPT (auto-category, tags, entities)
- Weekly digest summaries sent via Telegram
- MCP-compatible retrieval API (expose memories to AI agents)
- Re-enable RLS with user-scoped policies for multi-user support
- Web dashboard to browse and manage memories
