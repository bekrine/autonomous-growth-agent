import { z } from "zod";

/**
 * Fields every generated content package has regardless of format. Kept
 * separate from the format-specific structure (script/slides/etc.) below
 * so format handling stays a discriminated union, not one giant flat
 * object with a pile of always-optional fields.
 */
const baseContentFields = {
  hook: z.string().min(1),
  title: z.string().min(1),
  caption: z.string().min(1),
  callToAction: z.string().min(1),
  keywords: z.array(z.string().min(1)).max(8),
  altText: z.string().min(1),
  /** e.g. "unverified statistic", "medical claim" — flagged, never silently dropped. */
  contentWarnings: z.array(z.string()),
  /** Concise note on notable choices/assumptions — not chain-of-thought. */
  generationNotes: z.string(),
};

export const ReelSceneSchema = z.object({
  scene: z.string().min(1),
  voiceover: z.string().min(1),
  onScreenText: z.string(),
});

export const ReelContentSchema = z.object({
  format: z.literal("reel"),
  ...baseContentFields,
  script: z.array(ReelSceneSchema).min(1).max(8),
  visualDirection: z.string().min(1),
  estimatedDurationSeconds: z.number().min(5).max(120),
});

export const CarouselSlideSchema = z.object({
  slideNumber: z.number().int().min(1),
  headline: z.string().min(1),
  body: z.string().min(1),
  visualDirection: z.string().min(1),
});

export const CarouselContentSchema = z.object({
  format: z.literal("carousel"),
  ...baseContentFields,
  slides: z.array(CarouselSlideSchema).min(3).max(10),
});

export const ImageContentSchema = z.object({
  format: z.literal("image"),
  ...baseContentFields,
  headline: z.string().min(1),
  supportingText: z.string().min(1),
  visualDirection: z.string().min(1),
});

export const TextContentSchema = z.object({
  format: z.literal("text"),
  ...baseContentFields,
  body: z.string().min(1),
});

export const GeneratedContentSchema = z.discriminatedUnion("format", [
  ReelContentSchema,
  CarouselContentSchema,
  ImageContentSchema,
  TextContentSchema,
]);

export type ReelContent = z.infer<typeof ReelContentSchema>;
export type CarouselContent = z.infer<typeof CarouselContentSchema>;
export type ImageContent = z.infer<typeof ImageContentSchema>;
export type TextContent = z.infer<typeof TextContentSchema>;
export type GeneratedContent = z.infer<typeof GeneratedContentSchema>;

export const CONTENT_FORMATS = ["reel", "carousel", "image", "text"] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];

/**
 * The LLM call always validates against the single format-specific schema,
 * never the full discriminated union — the prompt already tells the model
 * exactly which format to produce, so this keeps generation unambiguous
 * (and lets the mock provider fake the right shape instead of always
 * defaulting to the union's first member).
 */
export const CONTENT_SCHEMA_BY_FORMAT = {
  reel: ReelContentSchema,
  carousel: CarouselContentSchema,
  image: ImageContentSchema,
  text: TextContentSchema,
} satisfies Record<ContentFormat, z.ZodTypeAny>;

/**
 * `content_ideas.format` is free text from ContentPlannerAgent's LLM
 * output, so it arrives as things like "short-form video", "text post" or
 * "Carousel" rather than the exact enum values. Match on keywords, most
 * specific first, and only fall back to "image" when nothing matches.
 */
const FORMAT_KEYWORDS: [ContentFormat, string[]][] = [
  ["carousel", ["carousel", "slide", "swipe"]],
  ["reel", ["reel", "video", "short-form", "short form", "tiktok", "story"]],
  ["text", ["text", "caption-only", "caption only", "thread", "tweet", "post copy"]],
  ["image", ["image", "photo", "graphic", "static", "picture", "infographic"]],
];

export function normalizeContentFormat(format: string | null | undefined): ContentFormat {
  const lower = (format ?? "").toLowerCase().trim();
  if (CONTENT_FORMATS.includes(lower as ContentFormat)) return lower as ContentFormat;

  for (const [candidate, keywords] of FORMAT_KEYWORDS) {
    if (keywords.some((keyword) => lower.includes(keyword))) return candidate;
  }
  return "image";
}
