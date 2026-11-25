// Validation for the optional "dishes" form field: the dishes identified in a
// photo, each with links to recipes for it.

export type Recipe = { title: string; url: string };
export type Dish = { name: string; main: boolean; recipes: Recipe[] };
// Stored as-is in food_photos.dishes. The main dish is always items[0].
export type Dishes = { items: Dish[] };

export class DishesValidationError extends Error {}

const MAX_JSON_LENGTH = 8000;
const MAX_DISHES = 3;
const MAX_NAME_LENGTH = 80;
const MAX_TITLE_LENGTH = 120;
const MAX_URL_LENGTH = 2000;

// Every photo carries 3 recipes. With fewer than 3 dishes the spare recipes go
// to the main dish, as further guesses at what it is.
// Dish count -> [recipes for the main dish, recipes for each other dish].
const RECIPE_COUNTS: Record<number, [number, number]> = {
  1: [3, 0],
  2: [2, 1],
  3: [1, 1],
};
const RECIPE_RULES: Record<number, string> = {
  1: "With 1 dish it needs 3 recipes.",
  2: "With 2 dishes the main dish needs 2 recipes and the other dish 1.",
  3: "With 3 dishes each dish needs exactly 1 recipe.",
};

function fail(message: string): never {
  throw new DishesValidationError(`dishes: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    fail(`${label} must be a string.`);
  }
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) {
    fail(`${label} must not be empty.`);
  }
  if (text.length > maxLength) {
    fail(`${label} must be at most ${maxLength} characters.`);
  }
  return text;
}

// Only plain web links are stored, since the site renders these as <a href>.
function readUrl(value: unknown, label: string): string {
  const text = readText(value, label, MAX_URL_LENGTH);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    fail(`${label} must be a full URL starting with https://.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail(`${label} must be an http or https URL.`);
  }
  if (url.username || url.password) {
    fail(`${label} must not contain a username or password.`);
  }
  return url.href;
}

function readRecipe(value: unknown, label: string): Recipe {
  if (!isRecord(value)) {
    fail(`${label} must be an object with title and url.`);
  }
  return {
    title: readText(value.title, `${label}.title`, MAX_TITLE_LENGTH),
    url: readUrl(value.url, `${label}.url`),
  };
}

function readDish(value: unknown, label: string): Dish {
  if (!isRecord(value)) {
    fail(`${label} must be an object with name, main and recipes.`);
  }
  if (value.main !== undefined && typeof value.main !== "boolean") {
    fail(`${label}.main must be true or false.`);
  }
  if (!Array.isArray(value.recipes)) {
    fail(`${label}.recipes must be an array.`);
  }
  return {
    name: readText(value.name, `${label}.name`, MAX_NAME_LENGTH),
    main: value.main === true,
    recipes: value.recipes.map((recipe, index) =>
      readRecipe(recipe, `${label}.recipes[${index}]`)
    ),
  };
}

// Parses the form field into the stored shape, or throws DishesValidationError
// with a message the sender can act on.
export function parseDishes(raw: string): Dishes {
  if (raw.length > MAX_JSON_LENGTH) {
    fail(`must be at most ${MAX_JSON_LENGTH} characters of JSON.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail('must be valid JSON, e.g. {"items":[{"name":"...","main":true,"recipes":[...]}]}.');
  }

  // A bare array of dishes is accepted as well as {"items": [...]}.
  const list = Array.isArray(payload) ? payload : isRecord(payload) ? payload.items : null;
  if (!Array.isArray(list)) {
    fail('must be an object with an "items" array.');
  }
  if (list.length < 1 || list.length > MAX_DISHES) {
    fail(`items must hold 1 to ${MAX_DISHES} dishes.`);
  }

  const dishes = list.map((item, index) => readDish(item, `items[${index}]`));

  if (dishes.length === 1) {
    dishes[0].main = true;
  } else if (dishes.filter((dish) => dish.main).length !== 1) {
    fail('exactly one dish must have "main": true.');
  }

  const names = new Set(dishes.map((dish) => dish.name.toLowerCase()));
  if (names.size !== dishes.length) {
    fail("each dish needs a different name.");
  }

  const [mainCount, otherCount] = RECIPE_COUNTS[dishes.length];
  for (const dish of dishes) {
    if (dish.recipes.length !== (dish.main ? mainCount : otherCount)) {
      fail(`${RECIPE_RULES[dishes.length]} "${dish.name}" has ${dish.recipes.length}.`);
    }
  }

  const urls = dishes.flatMap((dish) => dish.recipes.map((recipe) => recipe.url));
  if (new Set(urls).size !== urls.length) {
    fail("each recipe needs a different url.");
  }

  // Main dish first; the others keep the order they were sent in.
  return { items: [...dishes.filter((dish) => dish.main), ...dishes.filter((dish) => !dish.main)] };
}
