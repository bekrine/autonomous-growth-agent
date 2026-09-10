export function buildImageInstructions(): string {
  return [
    "Format: IMAGE — a single static post.",
    'Respond with JSON: { "format": "image", "hook": string, "title": string, "headline": string, "supportingText": string, "visualDirection": string, "caption": string, "callToAction": string, "keywords": string[] (max 8), "altText": string, "contentWarnings": string[], "generationNotes": string }',
    "headline is the short text meant to render directly on the image; supportingText is a brief secondary line, if useful (can be empty string).",
    "visualDirection describes the image concept concretely enough for an image-generation model to render it — subject, composition, mood, style. No text about text-on-image here; that's headline/supportingText.",
    "altText must describe the actual visual content factually and concisely (e.g. \"Carousel showing three AI coding tools with their main benefits for software developers.\") — never just copy the caption.",
  ].join("\n");
}
