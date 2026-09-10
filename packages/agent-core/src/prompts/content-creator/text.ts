export function buildTextInstructions(): string {
  return [
    "Format: TEXT — a text-only post (no media).",
    'Respond with JSON: { "format": "text", "hook": string, "title": string, "body": string, "caption": string, "callToAction": string, "keywords": string[] (max 8), "altText": string, "contentWarnings": string[], "generationNotes": string }',
    "body is the full post: opening hook, developed point(s), and a natural lead-in to the call to action. caption may restate/shorten body if the platform separates them, or mirror it.",
    "altText should be a short empty-content note (e.g. \"Text-only post, no image.\") since there is no visual — do not invent one.",
  ].join("\n");
}
