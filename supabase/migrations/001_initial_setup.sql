-- Step 1: Enable pgvector
create extension if not exists vector;

-- Step 2: Create dedicated schema
create schema if not exists brain;

-- Step 3: Create memories table
create table if not exists brain.memories (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  category text,
  metadata jsonb default '{}',
  embedding vector(1536),
  source text default 'telegram',
  created_at timestamp default now()
);

-- Step 4: Create embedding job queue table
create table if not exists brain.embedding_jobs (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid references brain.memories(id) on delete cascade,
  status text default 'pending',
  retry_count int default 0,
  created_at timestamp default now()
);

-- Step 5: Disable RLS (re-enable later with proper policies)
alter table brain.memories disable row level security;
alter table brain.embedding_jobs disable row level security;

-- Step 6: Grant REST API access to the brain schema
grant usage on schema brain to anon;
grant usage on schema brain to service_role;
grant all on brain.memories to anon;
grant all on brain.embedding_jobs to anon;
grant all on brain.memories to service_role;
grant all on brain.embedding_jobs to service_role;

-- Step 7: Expose the brain schema via PostgREST
-- Run this in Supabase Dashboard → Settings → API → Exposed schemas
-- Add "brain" to the list alongside "public"
-- OR run the following (requires superuser):
-- alter role authenticator set pgrst.db_schemas = 'public,brain';
-- notify pgrst, 'reload config';

-- Step 8: Create semantic search function
create or replace function brain.match_memories(
  query_embedding vector(1536),
  match_threshold float default 0.3,
  match_count int default 100
)
returns table (
  id uuid,
  content text,
  category text,
  metadata jsonb,
  similarity float,
  created_at timestamp
)
language sql stable
as $$
  select
    m.id,
    m.content,
    m.category,
    m.metadata,
    1 - (m.embedding <=> query_embedding) as similarity,
    m.created_at
  from brain.memories m
  where m.embedding is not null
    and 1 - (m.embedding <=> query_embedding) > match_threshold
  order by m.created_at asc
  limit match_count;
$$;
