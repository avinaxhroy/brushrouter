export type RecipeMode = "categories" | "related" | "one" | "brainstorm";
export type RecipeInput = "text" | "image";
export type RecipeKind = "job" | "look";
export type ImageSize =
  | "1024x1024" | "1536x864" | "1344x1008" | "864x1536"
  | "1024x1536" | "1008x1344" | "1024x1280";

export const RECIPES_DIR: string;
export const STYLES_FILE: string;
export const MODES: RecipeMode[];
export const STRICT_SLOTS: Set<string>;
export const INPUTS: RecipeInput[];
export const KINDS: RecipeKind[];
export const MAX_LIMIT: 10;

export class TokenIndex {
  constructor(tokenSet: ReadonlySet<string>);
  exact: ReadonlySet<string>;
  byPrefix4: Map<string, string[]>;
  matches(word: string): boolean;
}

export interface StyleSource {
  repo?: string;
  commit?: string;
  license?: string;
  copyright?: string;
}

export interface RecipeSource extends StyleSource {
  styleName?: string;
  styleVersion?: string;
  upstreamCategory?: string;
}

export interface RecipeImage {
  accepts: string;
  preserve: string[];
  skeleton: string;
}

export interface Recipe {
  id: string;
  category: string;
  kind: RecipeKind;
  goal: string;
  when: string;
  shape: string;
  slots: string[];
  defaults?: Record<string, string>;
  text: string;
  image?: RecipeImage | null;
  styleLock?: string[];
  doNotClone?: string[];
  negatives?: string[];
  example?: string;
  source?: RecipeSource | null;
  custom?: boolean;
}

export interface IndexedRecipe extends Recipe {
  categoryLabel: string;
  _match: Set<string>;
  _matchIndex: TokenIndex;
  _lock: Set<string>;
  _lockIndex: TokenIndex;
  _options: Set<string>;
  _optionsIndex: TokenIndex;
  _optionPhrases: readonly string[];
  _aliases: readonly string[];
  _phraseAliases: readonly string[];
  _wordAliases: readonly string[];
  _defaultValues: Record<string, string>;
  _slotOptions: Record<string, string[]>;
  _cleanText: string;
  _cleanImageSkeleton: string | null;
  _gist200: string;
}

export interface RecipeSlot {
  label: string;
  options: string[];
  free?: boolean;
}

interface CategorySummary {
  id: string;
  kind: RecipeKind;
  label: string;
  intent: string;
  count: number;
}

export interface RecipeCategory extends CategorySummary {
  shapes: { id: string; means: string }[];
}

export interface IndexedCategory extends CategorySummary {
  aliases: string[];
  recipes: string[];
  _phraseAliases: readonly string[];
  _wordAliases: readonly string[];
}

export type RecipeCounts = Record<RecipeKind, number>;

export interface RecipeLibrary {
  version: number;
  note: string;
  slots: Record<string, RecipeSlot>;
  freeSlots: string[];
  shapes: Record<string, string>;
  categories: IndexedCategory[];
  recipes: IndexedRecipe[];
  recipesByKind: Record<RecipeKind, IndexedRecipe[]>;
  recipesByCategory: Map<string, IndexedRecipe[]>;
  recipesWithImage: (IndexedRecipe & { image: RecipeImage })[];
  counts: RecipeCounts;
  categoryIds: Record<RecipeKind | "all", string[]>;
  recipeIds: Record<RecipeKind | "all", string[]>;
  listCategories: Record<RecipeKind | "all", RecipeCategory[]>;
  styleSource: StyleSource | null;
  categoryById: Map<string, IndexedCategory>;
  recipeById: Map<string, IndexedRecipe>;
}

export interface FindRecipesOptions {
  query?: string | null;
  category?: string | null;
  kind?: RecipeKind | null;
  input?: RecipeInput;
  shape?: string | null;
  mode?: RecipeMode;
  limit?: number | `${number}`;
  offset?: number | `${number}`;
  seed?: number | string;
  id?: string | null;
  diverse?: boolean;
}

export interface RecipeSuggestions {
  nearMatches: (Pick<Recipe, "id" | "kind" | "category"> & { gist: string })[];
  categories: string[];
}

interface RecipeSearchPage {
  mode: RecipeMode;
  query: string | null;
  category: string | null;
  kind: RecipeKind | null;
  input: RecipeInput;
  shape: string | null;
  limit: number;
  offset: number;
}

export type FindRecipesResult = RecipeSearchPage & (
  | { matched: true; total: number; available: number; hasMore: boolean; rows: IndexedRecipe[]; suggestions?: never }
  | { matched: false; total: 0; available: 0; hasMore: false; rows: []; suggestions: RecipeSuggestions }
);

export interface FillOptions {
  values?: Record<string, unknown>;
  input?: RecipeInput;
  includeNegatives?: boolean;
  twist?: string | null;
}

export interface InvalidSlotValue {
  slot: string;
  value: string;
  reason: string;
}

export interface FilledPrompt {
  text: string;
  missing: string[];
  usedImage: boolean;
  invalidValues: InvalidSlotValue[];
  ratio: string | null;
  suggestedSize: ImageSize | null;
}

export type ComposePromptOptions = FillOptions & (
  | { recipeId: string; lookId?: string | null }
  | { recipeId?: string | null; lookId: string }
);

export interface ComposedPrompt extends FilledPrompt {
  recipeId: string;
  lookId: string | null;
  source: RecipeSource | null;
}

export interface PublicRecipeOptions extends FillOptions {
  full?: boolean;
  lookId?: string | null;
}

interface PublicRecipeBase extends Pick<Recipe, "id" | "kind" | "category" | "goal" | "when" | "shape" | "slots"> {
  shapeMeans: string;
  defaults: Record<string, string>;
  slotOptions: Record<string, string[]>;
  strictSlots: string[];
  acceptsImage: boolean;
  imageAccepts: string | null;
  imagePreserves: string[] | null;
  negatives: string[];
  styleLock: string[];
  doNotClone: string[];
  source: RecipeSource | null;
  missing: string[];
  fillMe: string[];
  usedImage: boolean;
  suggestedSize?: ImageSize;
}

export interface RecipePreview extends PublicRecipeBase {
  gist: string;
}

export interface FullPublicRecipe extends PublicRecipeBase {
  prompt: string;
  example: string | undefined;
  invalidValues?: InvalidSlotValue[];
}

export function ratioToSize(ratio?: unknown): ImageSize | null;
export function loadRecipes(): RecipeLibrary;
export function resetRecipesCache(): void;
export function categoryIds(kind?: RecipeKind | null): string[];
export function recipeIds(kind?: RecipeKind | null): string[];
export function recipeCounts(): RecipeCounts;
export function listCategories(options?: { kind?: RecipeKind | null }): RecipeCategory[];
/** @throws {Error} If the recipe ID is unknown. */
export function getRecipe(id: string): IndexedRecipe;
export function findRecipes(options?: FindRecipesOptions): FindRecipesResult;
export function fill(recipe: Pick<Recipe, "text" | "slots" | "image" | "styleLock" | "doNotClone" | "negatives"> & { _defaultValues?: Record<string, string> }, options?: FillOptions): FilledPrompt;
export function composePrompt(options: ComposePromptOptions): ComposedPrompt;
export function gistOf(recipe: Pick<Partial<Recipe>, "goal" | "when">, chars?: number): string;
export function publicRecipe(recipe: Recipe, options?: PublicRecipeOptions & { full?: false }): RecipePreview;
export function publicRecipe(recipe: Recipe, options: PublicRecipeOptions & { full: true }): FullPublicRecipe;
export function publicRecipe(recipe: Recipe, options: PublicRecipeOptions): RecipePreview | FullPublicRecipe;
export function renderCategories(kind?: RecipeKind | null): string;
export function renderRecipe(recipe: Recipe, options?: PublicRecipeOptions & { index?: number | null }): string;
export function renderResult(result: FindRecipesResult, options?: Omit<PublicRecipeOptions, "input"> & { input?: RecipeInput | null }): string;
