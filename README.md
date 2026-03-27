# Open Brain

> Your thoughts, captured in Telegram — stored, embedded, and semantically searchable forever.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Supabase](https://img.shields.io/badge/Supabase-Edge%20Functions-3ECF8E?logo=supabase)](https://supabase.com)
[![OpenAI](https://img.shields.io/badge/OpenAI-Embeddings-412991?logo=openai)](https://platform.openai.com)
[![Deno](https://img.shields.io/badge/Runtime-Deno-000000?logo=deno)](https://deno.land)

**Open Brain** is a self-hosted, open-source second brain. Send any thought, idea, note, or link to your personal Telegram bot. It gets stored in a vector database and becomes instantly searchable using natural language — no app to open, no folder to organize, no friction.

Just message. Then search.

---

## What is a Second Brain?

A second brain is a personal knowledge system — a place where your thoughts, ideas, and information live outside your head, ready to be retrieved when you need them. Open Brain makes this effortless:

- **Capture**: Send a message to your Telegram bot. Done.
- **Store**: The message is saved to a PostgreSQL database with pgvector.
- **Embed**: OpenAI generates a semantic embedding (vector) for the message.
- **Search**: Type `/search memory about project X` and get back all matching memories as bullet points in the order you captured them.

---

## How It Works

```
You → Telegram message
         ↓
  telegram-webhook (Supabase Edge Function)
         ↓
  Stores message in brain.memories table
         ↓
  Queues embedding job in brain.embedding_jobs
         ↓
  process-embeddings (runs every minute via Supabase Cron)
         ↓
  Calls OpenAI text-embedding-3-small → 1536-dim vector
         ↓
  Stores vector in brain.memories.embedding (pgvector)
         ↓
  /search query → same embedding pipeline → match_memories()
         ↓
  All matching memories returned as bullet points (chronological order)
```

---

## Features

- **Capture via Telegram** — no app, no friction, works from your phone
- **Semantic search** — `/search` finds memories by meaning and returns them as bullet points in the order you captured them
- **pgvector similarity** — cosine distance search over 1536-dimension OpenAI embeddings
- **Async embedding queue** — webhook responds instantly; embeddings processed in background
- **Auto-retry** — failed embedding jobs retry up to 3 times before marking as failed
- **Supabase Cron** — embedding worker runs every minute automatically
- **Webhook security** — Telegram secret token verification blocks forged requests
- **Free-tier friendly** — runs entirely on Supabase free tier + OpenAI pay-as-you-go

---

## Tech Stack

| Layer | Technology |
|---|---|
| Bot interface | Telegram Bot API |
| Backend runtime | Supabase Edge Functions (Deno) |
| Database | PostgreSQL (Supabase) |
| Vector search | pgvector extension |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dims) |
| Job automation | Supabase Cron |

---

## Project Structure

```
open-brain/
├── supabase/
│   ├── migrations/
│   │   └── 001_initial_setup.sql     ← all DB setup: schema, tables, search function
│   └── functions/
│       ├── deno.json                 ← Deno compiler config for IDE support
│       ├── telegram-webhook/
│       │   └── index.ts             ← receives Telegram messages, handles /search
│       └── process-embeddings/
│           └── index.ts             ← fetches pending jobs, calls OpenAI, stores vectors
├── .env.example                      ← required secrets reference
├── doc.md                            ← detailed step-by-step setup guide
└── README.md
```

---

## Prerequisites

You need accounts/access to:

- [Supabase](https://supabase.com) — free account is enough
- [OpenAI Platform](https://platform.openai.com) — for embeddings (pay-as-you-go, very cheap)
- [Telegram](https://telegram.org) — to create a bot via `@BotFather`

No local server, no Docker, no infra to manage. Everything runs serverless.

---

## Quick Start

### 1. Clone the repo

```bash
git clone https://github.com/yourusername/open-brain.git
cd open-brain
```

### 2. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a new project. Note your **Project URL** and **anon key** from Settings → API.

### 3. Run the database migration

In **Supabase SQL Editor**, paste and run the contents of:

```
supabase/migrations/001_initial_setup.sql
```

This creates the `brain` schema, `memories` table, `embedding_jobs` queue, and the `match_memories()` semantic search function.

### 4. Expose the brain schema

In **Supabase Dashboard → Settings → API → Exposed schemas**, add `brain` alongside `public`. Save.

> This is required for Edge Functions to reach the `brain` schema via REST API.

### 5. Create a Telegram bot

Open Telegram → search `@BotFather` → send `/newbot` → follow prompts → copy your **Bot Token**.

### 6. Set secrets in Supabase

Go to **Project Settings → Edge Functions → Secrets** and add:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Your project URL |
| `SUPABASE_ANON_KEY` | Your anon key |
| `OPENAI_API_KEY` | Your OpenAI key |
| `TELEGRAM_BOT_TOKEN` | Token from BotFather |
| `TELEGRAM_SECRET_TOKEN` | Any random string (e.g. run `openssl rand -hex 32`) |

### 7. Deploy Edge Functions

In **Supabase Dashboard → Edge Functions**, create two functions:

- `telegram-webhook` — paste contents of `supabase/functions/telegram-webhook/index.ts`
- `process-embeddings` — paste contents of `supabase/functions/process-embeddings/index.ts`

For `process-embeddings`, disable JWT verification (Settings → Verify JWT → Off) so Supabase Cron can call it.

### 8. Register the Telegram webhook

Open this URL in your browser (replace the placeholders):

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<PROJECT_ID>.supabase.co/functions/v1/telegram-webhook&secret_token=<TELEGRAM_SECRET_TOKEN>
```

You should see: `{"ok":true,"result":true,"description":"Webhook was set"}`

### 9. Set up Supabase Cron

Go to **Supabase Dashboard → Integrations → Cron → Create a new job**:

- Name: `process-embeddings`
- Schedule: `* * * * *` (every minute)
- Type: Edge Function
- Function: `process-embeddings`

### 10. Send your first memory

Message your bot anything:

```
Ravi suggested offline attendance sync
```

Check **Supabase Table Editor → brain.memories** — a new row appears. Within a minute, the `embedding` column fills with a vector.

---

## Usage

### Capture a memory

Just send any text to your bot:

```
OpenAI embeddings use cosine similarity for semantic search
The best time to plant a tree was 20 years ago
Meeting notes: discussed Q2 roadmap with Sarah
```

### Search your memories

```
/search vector database
/search Q2 roadmap
/search things Sarah said
```

The bot replies with all matching memories as bullet points in the order you captured them:

```
3 memories found for "Q2 roadmap":

• Meeting notes: discussed Q2 roadmap with Sarah
• Sarah wants to prioritize the mobile launch in April
• Q2 key milestones agreed — finalize by end of month
```

---

## Environment Variables

| Variable | Description | Where to get it |
|---|---|---|
| `SUPABASE_URL` | Your Supabase project URL | Dashboard → Settings → API |
| `SUPABASE_ANON_KEY` | Supabase anonymous API key | Dashboard → Settings → API |
| `OPENAI_API_KEY` | OpenAI API key | platform.openai.com → API Keys |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | `@BotFather` → `/newbot` |
| `TELEGRAM_SECRET_TOKEN` | Random secret to verify webhook origin | Generate with `openssl rand -hex 32` |

Copy `.env.example` to `.env` for local reference (never commit `.env`).

---

## Detailed Setup Guide

For a full step-by-step walkthrough including troubleshooting and architecture decisions, see [doc.md](doc.md).

---

## What Can You Build On Top of This?

Open Brain is a foundation. Once your memories are embedded and stored, you can extend it:

- **AI chat over your memories** — connect to Claude or GPT and answer questions using your stored knowledge
- **Weekly digest** — summarize and email your recent memories
- **Tagging and categories** — auto-classify memories with GPT
- **MCP-compatible API** — expose memories to AI agents via the Model Context Protocol
- **Web dashboard** — browse and manage memories in a UI
- **Multi-user** — re-enable RLS with user-scoped policies for team use

---

## Contributing

Pull requests are welcome. For major changes, open an issue first to discuss what you'd like to change.

Ideas for contribution:
- Additional capture interfaces (WhatsApp, SMS, email)
- Memory classification with LLMs
- Export to Obsidian / Notion
- Tests for Edge Functions

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.
