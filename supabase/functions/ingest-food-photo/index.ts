import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
  MagickImageInfo,
  MagickReadSettings,
} from "npm:@imagemagick/magick-wasm@0.0.30";
import { type Dishes, DishesValidationError, parseDishes } from "./dishes.ts";

const TABLE = "food_photos";
const BUCKET = "food-photos";
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// Multipart framing plus the text fields on top of the file itself.
const MAX_BODY_BYTES = MAX_FILE_BYTES + 64 * 1024;
// Full-size decodes above this would not fit in the function's 256 MB.
const MAX_DECODE_PIXELS = 16_000_000;
const MAX_WIDTH = 1200;
const WEBP_QUALITY = 80;
const MAX_CAPTION_LENGTH = 120;
const UNIQUE_VIOLATION = "23505";

// An explicit offset is required so a local time is never silently read as UTC.
const ISO_WITH_TIMEZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Pinned: this version ships a single magick.wasm next to its entry point.
const wasmBytes = await Deno.readFile(
  new URL("magick.wasm", import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.30")),
);
await initializeImageMagick(wasmBytes);

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function reply(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

async function sha256(data: BufferSource): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Compares digests so the check takes the same time wherever the strings differ.
async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    sha256(encoder.encode(provided)),
    sha256(encoder.encode(expected)),
  ]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a[i] ^ b[i];
  }
  return difference === 0;
}

// Only these three are decoded. Anything else (HEIC included) is rejected before
// it reaches the image library; the sender converts it to JPEG first.
function sniffFormat(bytes: Uint8Array): MagickFormat | null {
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((value, index) => bytes[offset + index] === value);

  if (startsWith([0xff, 0xd8, 0xff])) {
    return MagickFormat.Jpeg;
  }
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return MagickFormat.Png;
  }
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return MagickFormat.WebP;
  }
  return null;
}

function readTextField(form: FormData, name: string): string {
  const value = form.get(name);
  if (value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new RequestError(400, `${name} must be a text field`);
  }
  return value.replace(/\s+/g, " ").trim();
}

function readCaption(form: FormData): string | null {
  const caption = readTextField(form, "caption");
  if (caption.length > MAX_CAPTION_LENGTH) {
    throw new RequestError(400, `caption must be at most ${MAX_CAPTION_LENGTH} characters`);
  }
  return caption || null;
}

function readTakenAt(form: FormData): string {
  const value = readTextField(form, "taken_at");
  if (!value) {
    return new Date().toISOString();
  }
  const parsed = new Date(value);
  if (!ISO_WITH_TIMEZONE.test(value) || Number.isNaN(parsed.getTime())) {
    throw new RequestError(
      400,
      "taken_at must be an ISO-8601 timestamp with a timezone, " +
        "e.g. 2026-11-18T23:02:00Z or 2026-11-18T18:02:00-05:00",
    );
  }
  return parsed.toISOString();
}

// Optional SHA-256 of the original album file. A sender that converts photos
// (HEIC to JPEG) sends this so the same photo dedupes even if the converted
// bytes differ between runs. Without it the uploaded bytes are hashed.
function readPhotoHash(form: FormData): string | null {
  const value = readTextField(form, "photo_hash").toLowerCase();
  if (!value) {
    return null;
  }
  if (!SHA256_HEX.test(value)) {
    throw new RequestError(400, "photo_hash must be a SHA-256 hex digest (64 characters)");
  }
  return value;
}

// Optional JSON describing the dishes in the photo and recipes for them.
function readDishes(form: FormData): Dishes | null {
  const value = form.get("dishes");
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new RequestError(400, "dishes must be a text field");
  }
  if (!value.trim()) {
    return null;
  }
  try {
    return parseDishes(value);
  } catch (error) {
    if (error instanceof DishesValidationError) {
      throw new RequestError(400, error.message);
    }
    throw error;
  }
}

type ProcessedImage = { data: Uint8Array; width: number; height: number };

// Re-encodes to WebP at most MAX_WIDTH wide. All metadata (EXIF, GPS, XMP) is
// dropped; only the color profile is kept so colors render as shot.
function toWebp(bytes: Uint8Array, format: MagickFormat): ProcessedImage {
  const info = MagickImageInfo.create(bytes, new MagickReadSettings({ format }));
  const settings = new MagickReadSettings({ format });

  // A large JPEG is decoded at 1/2, 1/4 or 1/8 scale, which keeps a full-size
  // phone photo cheap. The hint is only set when at least a 1/2 scale leaves
  // both sides >= MAX_WIDTH; on a smaller image it would upscale instead.
  const scaledDecode = format === MagickFormat.Jpeg &&
    Math.min(info.width, info.height) >= 2 * MAX_WIDTH;
  if (scaledDecode) {
    settings.setDefine(MagickFormat.Jpeg, "size", `${MAX_WIDTH}x${MAX_WIDTH}`);
  } else if (info.width * info.height > MAX_DECODE_PIXELS) {
    throw new RequestError(413, "Image has too many pixels. Downscale it before uploading.");
  }

  return ImageMagick.read(bytes, settings, (image): ProcessedImage => {
    // Bake the EXIF rotation into the pixels before the EXIF data is removed.
    image.autoOrient();
    if (image.width > MAX_WIDTH) {
      image.resize(MAX_WIDTH, Math.max(1, Math.round((image.height * MAX_WIDTH) / image.width)));
    }
    // getProfile returns a view into memory that strip() frees, so copy it first.
    const colorProfile = image.getProfile("icc")?.data.slice();
    image.strip();
    if (colorProfile) {
      image.setProfile("icc", colorProfile);
    }
    image.quality = WEBP_QUALITY;
    // Encoder effort 2 (scale 0-6, default 4): about 2.4x faster for ~4% larger
    // files, which keeps a full-size photo well inside the 2 s CPU limit.
    image.settings.setDefine(MagickFormat.WebP, "method", "2");
    return image.write(MagickFormat.WebP, (data) => ({
      // The callback's buffer is only valid inside the callback, so copy it.
      data: new Uint8Array(data),
      width: image.width,
      height: image.height,
    }));
  });
}

async function readForm(req: Request): Promise<FormData> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    throw new RequestError(413, "Request body is too large.");
  }
  try {
    return await req.formData();
  } catch {
    throw new RequestError(400, "Request body must be multipart/form-data.");
  }
}

async function ingest(req: Request, supabaseUrl: string, serviceRoleKey: string) {
  const form = await readForm(req);

  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new RequestError(400, "file is required (multipart/form-data field named file).");
  }
  if (file.size === 0) {
    throw new RequestError(400, "file is empty.");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new RequestError(413, `file must be at most ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
  }

  const sentCaption = readCaption(form);
  const dishes = readDishes(form);
  // With dishes, the photo is labelled with its main dish (always items[0]).
  const caption = dishes ? dishes.items[0].name : sentCaption;
  const takenAt = readTakenAt(form);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const photoHash = readPhotoHash(form) ?? toHex(await sha256(bytes));

  const format = sniffFormat(bytes);
  if (!format) {
    throw new RequestError(
      415,
      "Unsupported image type. Send JPEG, PNG or WebP (convert HEIC to JPEG first).",
    );
  }

  // Dedupe before any image work so re-sending a synced photo is cheap.
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data: existing, error: lookupError } = await supabase
    .from(TABLE)
    .select("id, caption, dishes")
    .eq("photo_hash", photoHash)
    .maybeSingle();
  if (lookupError) {
    throw new RequestError(500, lookupError.message);
  }
  if (existing) {
    // A photo synced without dishes (the backfill) gets them the first time
    // they are sent. Dishes that are already stored are never overwritten, so
    // repeat runs change nothing. A caption written by hand is kept.
    if (dishes && existing.dishes === null) {
      const keptCaption = typeof existing.caption === "string" && existing.caption.trim()
        ? existing.caption
        : caption;
      const { data: updated, error: updateError } = await supabase
        .from(TABLE)
        .update({ dishes, caption: keptCaption })
        .eq("id", existing.id)
        .is("dishes", null)
        .select("id");
      if (updateError) {
        throw new RequestError(500, updateError.message);
      }
      if (updated && updated.length > 0) {
        return { status: "updated", photo_hash: photoHash, caption: keptCaption, dishes };
      }
    }
    return { status: "duplicate", photo_hash: photoHash };
  }

  let image: ProcessedImage;
  try {
    image = toWebp(bytes, format);
  } catch (error) {
    if (error instanceof RequestError) {
      throw error;
    }
    throw new RequestError(400, "Could not decode the image. Is the file corrupt?");
  }

  // Content-addressed name, so re-uploading after a failed insert is harmless.
  const storagePath = `${photoHash}.webp`;
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, image.data, {
      contentType: "image/webp",
      cacheControl: "31536000",
      upsert: true,
    });
  if (uploadError) {
    throw new RequestError(500, `Storage upload failed: ${uploadError.message}`);
  }
  const publicUrl = supabase.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl;

  const { error: insertError } = await supabase.from(TABLE).insert({
    photo_hash: photoHash,
    storage_path: storagePath,
    public_url: publicUrl,
    caption,
    taken_at: takenAt,
    dishes,
  });
  if (insertError) {
    // Another request inserted the same photo between the lookup and here.
    if (insertError.code === UNIQUE_VIOLATION) {
      return { status: "duplicate", photo_hash: photoHash };
    }
    throw new RequestError(500, insertError.message);
  }

  return {
    status: "inserted",
    photo_hash: photoHash,
    public_url: publicUrl,
    caption,
    taken_at: takenAt,
    dishes,
    width: image.width,
    height: image.height,
    bytes: image.data.length,
  };
}

// Called by the phone workflow and the backfill script, never by the browser,
// so there are no CORS headers.
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return reply(405, { ok: false, error: "Method not allowed. Use POST." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ingestSecret = Deno.env.get("FOOD_INGEST_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !ingestSecret) {
    return reply(500, {
      ok: false,
      error: "Function is not configured. Set the FOOD_INGEST_SECRET secret.",
    });
  }

  const providedSecret = req.headers.get("x-food-ingest-secret") ?? "";
  if (!providedSecret || !(await secretsMatch(providedSecret, ingestSecret))) {
    return reply(401, { ok: false, error: "Missing or wrong x-food-ingest-secret header." });
  }

  try {
    return reply(200, { ok: true, ...(await ingest(req, supabaseUrl, serviceRoleKey)) });
  } catch (error) {
    if (error instanceof RequestError) {
      return reply(error.status, { ok: false, error: error.message });
    }
    throw error;
  }
});
