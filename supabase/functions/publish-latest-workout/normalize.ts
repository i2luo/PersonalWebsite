// Validation + normalization for the workout JSON posted by the phone workflow.
// Kept free of Deno/Supabase imports so it can be exercised with plain Node.

export type WorkoutSet = {
  type: "normal" | "warmup" | "dropset" | "failure";
  reps?: number;
  weight_kg?: number;
  weight_lbs?: number;
  rpe?: number;
  duration_seconds?: number;
  distance_km?: number;
};

export type WorkoutExercise = {
  name: string;
  sets: WorkoutSet[];
};

export type NormalizedWorkout = {
  title: string;
  started_at: string | null;
  ended_at: string | null;
  duration_min: number | null;
  exercise_count: number;
  exercises: WorkoutExercise[];
};

export class WorkoutValidationError extends Error {}

const MAX_TEXT_LENGTH = 120;
const MAX_EXERCISES = 40;
const MAX_SETS_PER_EXERCISE = 30;

// An explicit offset is required so a local time is never silently read as UTC.
const ISO_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

const SET_TYPES: Record<string, WorkoutSet["type"]> = {
  normal: "normal",
  warmup: "warmup",
  dropset: "dropset",
  failure: "failure",
};

function fail(message: string): never {
  throw new WorkoutValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function readText(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail(`${path} must be a string`);
  }
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) {
    fail(`${path} must not be empty`);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    fail(`${path} must be at most ${MAX_TEXT_LENGTH} characters`);
  }
  return text;
}

function readNumber(value: unknown, path: string): number | undefined {
  if (isMissing(value)) {
    return undefined;
  }
  const parsed =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    fail(`${path} must be a non-negative number`);
  }
  return parsed;
}

function readInteger(value: unknown, path: string): number | undefined {
  const parsed = readNumber(value, path);
  if (parsed !== undefined && !Number.isInteger(parsed)) {
    fail(`${path} must be a whole number`);
  }
  return parsed;
}

function readTimestamp(value: unknown, path: string): string | null {
  if (isMissing(value)) {
    return null;
  }
  if (typeof value !== "string" || !ISO_WITH_TIMEZONE.test(value.trim())) {
    fail(
      `${path} must be an ISO-8601 timestamp with a timezone, ` +
        `e.g. 2026-11-18T16:02:00Z or 2026-11-18T11:02:00-05:00`,
    );
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    fail(`${path} is not a valid date`);
  }
  return parsed.toISOString();
}

function readSetType(value: unknown): WorkoutSet["type"] {
  if (typeof value !== "string") {
    return "normal";
  }
  // "Warm-up", "warm up" and "WARMUP" all collapse to "warmup".
  return SET_TYPES[value.toLowerCase().replace(/[^a-z]/g, "")] ?? "normal";
}

function readSet(value: unknown, path: string): WorkoutSet {
  if (!isRecord(value)) {
    fail(`${path} must be an object`);
  }
  const set: WorkoutSet = { type: readSetType(value.type) };
  const fields: Array<[keyof Omit<WorkoutSet, "type">, number | undefined]> = [
    ["reps", readInteger(value.reps, `${path}.reps`)],
    ["weight_kg", readNumber(value.weight_kg, `${path}.weight_kg`)],
    ["weight_lbs", readNumber(value.weight_lbs, `${path}.weight_lbs`)],
    ["rpe", readNumber(value.rpe, `${path}.rpe`)],
    ["duration_seconds", readNumber(value.duration_seconds, `${path}.duration_seconds`)],
    ["distance_km", readNumber(value.distance_km, `${path}.distance_km`)],
  ];
  for (const [key, parsed] of fields) {
    if (parsed !== undefined) {
      set[key] = parsed;
    }
  }
  if (set.rpe !== undefined && set.rpe > 10) {
    fail(`${path}.rpe must be between 0 and 10`);
  }
  return set;
}

function readExercise(value: unknown, path: string): WorkoutExercise {
  if (!isRecord(value)) {
    fail(`${path} must be an object`);
  }
  const rawSets = isMissing(value.sets) ? [] : value.sets;
  if (!Array.isArray(rawSets)) {
    fail(`${path}.sets must be an array`);
  }
  if (rawSets.length > MAX_SETS_PER_EXERCISE) {
    fail(`${path}.sets must have at most ${MAX_SETS_PER_EXERCISE} sets`);
  }
  return {
    name: readText(value.name, `${path}.name`),
    sets: rawSets.map((set, index) => readSet(set, `${path}.sets[${index}]`)),
  };
}

/**
 * Accepts either the workout object itself or `{ "workout": { ... } }`.
 * Unknown fields are dropped; a wrong type on a known field throws
 * WorkoutValidationError with the offending path.
 */
export function normalizeWorkout(payload: unknown): NormalizedWorkout {
  if (!isRecord(payload)) {
    fail("Request body must be a JSON object");
  }
  const workout = isRecord(payload.workout) ? payload.workout : payload;

  if (isMissing(workout.title)) {
    fail("title is required");
  }
  const title = readText(workout.title, "title");

  const rawExercises = isMissing(workout.exercises) ? [] : workout.exercises;
  if (!Array.isArray(rawExercises)) {
    fail("exercises must be an array");
  }
  if (rawExercises.length > MAX_EXERCISES) {
    fail(`exercises must have at most ${MAX_EXERCISES} entries`);
  }
  const exercises = rawExercises.map((exercise, index) =>
    readExercise(exercise, `exercises[${index}]`)
  );

  const startedAt = readTimestamp(workout.started_at, "started_at");
  const endedAt = readTimestamp(workout.ended_at, "ended_at");
  if (startedAt && endedAt && endedAt < startedAt) {
    fail("ended_at must not be before started_at");
  }

  let durationMin = readNumber(workout.duration_min, "duration_min");
  if (durationMin === undefined && startedAt && endedAt) {
    durationMin = (Date.parse(endedAt) - Date.parse(startedAt)) / 60000;
  }

  return {
    title,
    started_at: startedAt,
    ended_at: endedAt,
    duration_min: durationMin === undefined ? null : Math.round(durationMin),
    exercise_count: readInteger(workout.exercise_count, "exercise_count") ??
      exercises.length,
    exercises,
  };
}
