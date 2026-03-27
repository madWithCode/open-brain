import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

// GET requests require Accept-Profile, write requests require Content-Profile
const BRAIN_READ_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
  "Accept-Profile": "brain",
};

const BRAIN_WRITE_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
  "Content-Profile": "brain",
};

const BATCH_SIZE = 5;
const MAX_RETRIES = 3;

serve(async () => {
  try {
    // Fetch pending jobs (up to BATCH_SIZE)
    const jobsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/embedding_jobs?status=eq.pending&retry_count=lt.${MAX_RETRIES}&limit=${BATCH_SIZE}&order=created_at.asc`,
      { headers: BRAIN_READ_HEADERS },
    );

    if (!jobsRes.ok) {
      const err = await jobsRes.text();
      console.error("Failed to fetch jobs:", err);
      return new Response("Failed to fetch jobs", { status: 500 });
    }

    const jobs = await jobsRes.json();

    if (jobs.length === 0) {
      return new Response("No pending jobs", { status: 200 });
    }

    console.log(`Processing ${jobs.length} embedding jobs`);

    const results = await Promise.allSettled(
      jobs.map((job: { id: string; memory_id: string; retry_count: number }) =>
        processJob(job)
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    return new Response(
      JSON.stringify({ processed: succeeded, failed }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("process-embeddings error:", err);
    return new Response("Internal error", { status: 500 });
  }
});

async function processJob(job: {
  id: string;
  memory_id: string;
  retry_count: number;
}) {
  try {
    // Fetch the memory content
    const memoryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/memories?id=eq.${job.memory_id}&select=id,content`,
      { headers: BRAIN_READ_HEADERS },
    );

    if (!memoryRes.ok) {
      throw new Error(`Failed to fetch memory: ${await memoryRes.text()}`);
    }

    const memories = await memoryRes.json();

    if (!memories || memories.length === 0) {
      throw new Error(`Memory ${job.memory_id} not found`);
    }

    const content = memories[0].content;

    // Generate embedding via OpenAI
    const embeddingRes = await fetch(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-3-small",
          input: content,
        }),
      },
    );

    if (!embeddingRes.ok) {
      const err = await embeddingRes.text();
      throw new Error(`OpenAI error: ${err}`);
    }

    const embeddingData = await embeddingRes.json();
    const embedding = embeddingData.data[0].embedding;

    // Patch memory with the generated embedding
    const updateMemoryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/memories?id=eq.${job.memory_id}`,
      {
        method: "PATCH",
        headers: BRAIN_WRITE_HEADERS,
        body: JSON.stringify({ embedding }),
      },
    );

    if (!updateMemoryRes.ok) {
      throw new Error(
        `Failed to update memory: ${await updateMemoryRes.text()}`,
      );
    }

    // Mark job as completed
    await fetch(
      `${SUPABASE_URL}/rest/v1/embedding_jobs?id=eq.${job.id}`,
      {
        method: "PATCH",
        headers: BRAIN_WRITE_HEADERS,
        body: JSON.stringify({ status: "completed" }),
      },
    );

    console.log(`Job ${job.id} completed for memory ${job.memory_id}`);
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err);

    // Increment retry count; mark as failed if max retries exceeded
    const newRetryCount = job.retry_count + 1;
    const newStatus = newRetryCount >= MAX_RETRIES ? "failed" : "pending";

    await fetch(
      `${SUPABASE_URL}/rest/v1/embedding_jobs?id=eq.${job.id}`,
      {
        method: "PATCH",
        headers: BRAIN_WRITE_HEADERS,
        body: JSON.stringify({
          retry_count: newRetryCount,
          status: newStatus,
        }),
      },
    ).catch((e) => console.error("Failed to update job status:", e));

    throw err;
  }
}
