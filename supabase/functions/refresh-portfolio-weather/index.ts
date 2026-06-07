import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const WEATHER_LABELS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with heavy hail",
};

function weatherLabel(code: number | null | undefined): string {
  if (code == null) {
    return "Weather update available";
  }
  return WEATHER_LABELS[code] ?? "Weather update available";
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response("Missing Supabase env", { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: configRows, error: configError } = await supabase
    .from("portfolio_weather_private_config")
    .select("latitude,longitude")
    .eq("id", 1)
    .limit(1);

  if (configError) {
    return new Response(configError.message, { status: 500 });
  }

  const config = configRows?.[0];
  if (!config) {
    return new Response("No coordinate config row (id=1)", { status: 500 });
  }

  const lat = config.latitude;
  const lng = config.longitude;

  const weatherParams = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
    temperature_unit: "celsius",
    wind_speed_unit: "kmh",
    timezone: "auto",
  });
  const geocodeParams = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    localityLanguage: "en",
  });

  const [weatherRes, geocodeRes] = await Promise.all([
    fetch(`https://api.open-meteo.com/v1/forecast?${weatherParams}`),
    fetch(`https://api-bdc.io/data/reverse-geocode-client?${geocodeParams}`),
  ]);

  if (!weatherRes.ok || !geocodeRes.ok) {
    return new Response("Upstream weather/geocode request failed", { status: 502 });
  }

  const weatherData = await weatherRes.json();
  const geocodeData = await geocodeRes.json();
  const current = weatherData.current;

  if (!current) {
    return new Response("Open-Meteo missing current weather", { status: 502 });
  }

  const city = geocodeData.city || geocodeData.locality || "Unknown city";
  const region = geocodeData.principalSubdivision || "";
  const country = geocodeData.countryName || "";
  const weatherCode = current.weather_code as number | null;
  const temperatureC = current.temperature_2m as number;
  const feelsLikeC = current.apparent_temperature as number;
  const windKmh = current.wind_speed_10m as number;

  if (
    temperatureC == null ||
    feelsLikeC == null ||
    windKmh == null ||
    Number.isNaN(temperatureC) ||
    Number.isNaN(feelsLikeC) ||
    Number.isNaN(windKmh)
  ) {
    return new Response("Open-Meteo missing numeric fields", { status: 502 });
  }

  const updatedAt = new Date().toISOString();
  const { error: upsertError } = await supabase.from("portfolio_weather_current").upsert({
    id: 1,
    city,
    region,
    country,
    temperature_c: temperatureC,
    feels_like_c: feelsLikeC,
    wind_kmh: windKmh,
    weather_code: weatherCode,
    weather_summary: weatherLabel(weatherCode),
    updated_at: updatedAt,
  });

  if (upsertError) {
    return new Response(upsertError.message, { status: 500 });
  }

  return Response.json({
    ok: true,
    city,
    region,
    country,
    updated_at: updatedAt,
  });
});
