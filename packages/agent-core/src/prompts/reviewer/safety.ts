/** Safety-dimension guidance, composed into the reviewer system prompt (see system.ts). */
export const SAFETY_CHECKLIST = [
  "No harmful, hateful, or disallowed content.",
  "No medical, legal, or financial advice presented as fact without an explicit disclaimer/hedge.",
  "No dangerous instructions (self-harm, illegal activity, unsafe practices).",
  "No unverifiable high-risk claims stated as established fact.",
].join("\n");
