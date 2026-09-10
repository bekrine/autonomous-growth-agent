export function buildCarouselInstructions(): string {
  return [
    "Format: CAROUSEL — a sequence of swipeable slides.",
    'Respond with JSON: { "format": "carousel", "hook": string, "title": string, "slides": [ { "slideNumber": number, "headline": string, "body": string, "visualDirection": string } ] (3-10 slides), "caption": string, "callToAction": string, "keywords": string[] (max 8), "altText": string, "contentWarnings": string[], "generationNotes": string }',
    "Slide 1 must restate/deliver the hook so a viewer decides to keep swiping. The final slide must contain a clear call to action (e.g. save/share/comment) matching callToAction.",
    "Keep each slide's body to one idea — don't cram multiple points onto one slide.",
    "altText should summarize the carousel's overall visual content across slides, not restate the caption.",
  ].join("\n");
}
