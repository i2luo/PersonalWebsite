import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ZENQUOTES_TODAY = "https://zenquotes.io/api/today";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const upstream = await fetch(ZENQUOTES_TODAY, {
      headers: { Accept: "application/json" },
    });

    if (!upstream.ok) {
      return new Response(`Upstream quote API failed (${upstream.status})`, {
        status: 502,
        headers: corsHeaders,
      });
    }

    const payload = await upstream.json();
    const first = Array.isArray(payload) ? payload[0] : null;
    const text = (first?.q ?? "").toString().trim();
    const author = (first?.a ?? "").toString().trim();

    if (!text) {
      return new Response("Quote payload missing text", { status: 502, headers: corsHeaders });
    }

    return Response.json(
      {
        text,
        author: author || "Unknown",
        date: first?.date ?? null,
        source: "zenquotes.io",
      },
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return new Response(message, { status: 500, headers: corsHeaders });
  }
});
