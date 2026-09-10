export function buildReelInstructions(): string {
  return [
    "Format: REEL — a short vertical video.",
    'Respond with JSON: { "format": "reel", "hook": string, "title": string, "script": [ { "scene": string, "voiceover": string, "onScreenText": string } ] (1-8 scenes), "visualDirection": string, "estimatedDurationSeconds": number (5-120), "caption": string, "callToAction": string, "keywords": string[] (max 8), "altText": string, "contentWarnings": string[], "generationNotes": string }',
    "Each script scene needs a clear visual beat (scene), what's said (voiceover), and any on-screen text overlay (onScreenText — can be empty string if none).",
    "The hook must work in the first 1-2 seconds — assume a scrolling viewer who hasn't committed to watching yet.",
    "altText should describe the video's key visual content for someone who can't watch it, not restate the caption.",
  ].join("\n");
}
