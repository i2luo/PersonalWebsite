import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { normalizeWorkout, WorkoutValidationError } from "./normalize.ts";

const TABLE = "portfolio_latest_workout";
const MAX_BODY_CHARS = 64 * 1024;

function reply(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

// Compares digests so the check takes the same time wherever the strings differ.
async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a[i] ^ b[i];
  }
  return difference === 0;
}

// Called by the phone workflow, never by the browser, so there are no CORS headers.
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return reply(405, { ok: false, error: "Method not allowed. Use POST." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publishSecret = Deno.env.get("HEVY_PUBLISH_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !publishSecret) {
    return reply(500, {
      ok: false,
      error: "Function is not configured. Set the HEVY_PUBLISH_SECRET secret.",
    });
  }

  const providedSecret = req.headers.get("x-publish-secret") ?? "";
  if (!providedSecret || !(await secretsMatch(providedSecret, publishSecret))) {
    return reply(401, { ok: false, error: "Missing or wrong x-publish-secret header." });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_CHARS) {
    return reply(413, { ok: false, error: "Request body is too large." });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return reply(400, { ok: false, error: "Request body is not valid JSON." });
  }

  let workout;
  try {
    workout = normalizeWorkout(payload);
  } catch (error) {
    if (error instanceof WorkoutValidationError) {
      return reply(400, { ok: false, error: error.message });
    }
    throw error;
  }

  const updatedAt = new Date().toISOString();
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { error: upsertError } = await supabase
    .from(TABLE)
    .upsert({ id: 1, ...workout, updated_at: updatedAt });

  if (upsertError) {
    return reply(500, { ok: false, error: upsertError.message });
  }

  return reply(200, {
    ok: true,
    title: workout.title,
    started_at: workout.started_at,
    exercise_count: workout.exercise_count,
    updated_at: updatedAt,
  });
});
