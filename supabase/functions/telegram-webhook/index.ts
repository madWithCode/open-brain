import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_SECRET_TOKEN = Deno.env.get("TELEGRAM_SECRET_TOKEN");

const BRAIN_WRITE_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
  "Content-Profile": "brain",
};

serve(async (req) => {
  try {
    // Optional: verify Telegram webhook secret
    if (TELEGRAM_SECRET_TOKEN) {
      const incomingSecret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (incomingSecret !== TELEGRAM_SECRET_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const rawBody = await req.text();
    if (!rawBody) return new Response("Empty body", { status: 400 });

    const body = JSON.parse(rawBody);
    const message = body.message?.text;

    if (!message) {
      // Silently accept non-text updates (photos, stickers, etc.)
      return new Response("OK");
    }

    const chatId = body.message?.chat?.id;
    const userId = body.message?.from?.id;
    const username = body.message?.from?.username;

    // Handle /search command
    if (message.startsWith("/search")) {
      const query = message.replace("/search", "").trim();

      if (!query) {
        await sendTelegramMessage(chatId, "Usage: /search <your query>");
        return new Response("OK");
      }

      const results = await searchMemories(query);
      await sendTelegramMessage(chatId, formatSearchResults(query, results));
      return new Response("OK");
    }

    // Store message as memory
    const insertMemoryRes = await fetch(
      `${SUPABASE_URL}/rest/v1/memories`,
      {
        method: "POST",
        headers: { ...BRAIN_WRITE_HEADERS, Prefer: "return=representation" },
        body: JSON.stringify({
          content: message,
          metadata: { chat_id: chatId, user_id: userId, username },
        }),
      },
    );

    if (!insertMemoryRes.ok) {
      const err = await insertMemoryRes.text();
      console.error("Memory insert failed:", err);
      return new Response("Insert failed", { status: 500 });
    }

    const memory = await insertMemoryRes.json();

    if (!memory || memory.length === 0) {
      console.error("Memory insert returned empty response");
      return new Response("Insert failed", { status: 500 });
    }

    // Queue embedding job
    const queueRes = await fetch(
      `${SUPABASE_URL}/rest/v1/embedding_jobs`,
      {
        method: "POST",
        headers: BRAIN_WRITE_HEADERS,
        body: JSON.stringify({ memory_id: memory[0].id }),
      },
    );

    if (!queueRes.ok) {
      console.error("Embedding job queue failed:", await queueRes.text());
      // Memory was stored — not a fatal error
    }

    return new Response("OK");
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("Internal error", { status: 500 });
  }
});

async function searchMemories(query: string) {
  // Generate embedding for the search query
  const embeddingRes = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: query }),
  });

  if (!embeddingRes.ok) {
    throw new Error(`OpenAI error: ${await embeddingRes.text()}`);
  }

  const { data } = await embeddingRes.json();
  const queryEmbedding = data[0].embedding;

  // Call match_memories RPC in the brain schema
  const searchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/match_memories`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        "Content-Profile": "brain",
      },
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        match_threshold: 0.5,
        match_count: 5,
      }),
    },
  );

  if (!searchRes.ok) {
    throw new Error(`Search failed: ${await searchRes.text()}`);
  }

  return await searchRes.json();
}

function formatSearchResults(
  query: string,
  results: { content: string; similarity: number }[],
): string {
  if (!results || results.length === 0) {
    return `No memories found for: "${query}"`;
  }

  const lines = results.map((r, i) => {
    const score = Math.round(r.similarity * 100);
    return `${i + 1}. (${score}% match)\n${r.content}`;
  });

  return `Search: "${query}"\n\n${lines.join("\n\n")}`;
}

async function sendTelegramMessage(chatId: number, text: string) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    },
  );

  if (!res.ok) {
    console.error("Failed to send Telegram message:", await res.text());
  }
}
