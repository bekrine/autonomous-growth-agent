/** Quality-dimension guidance, composed into the reviewer system prompt (see system.ts). */
export const QUALITY_CHECKLIST = [
  "Hook quality: specific and attention-earning, not a generic platitude.",
  "Clarity: the point is understandable on a first read/watch.",
  "Coherence: hook, body, caption and CTA all support the same idea.",
  "Usefulness: a member of the stated target audience would get real value from it.",
  "Specificity: concrete details/examples beat vague generalities.",
].join("\n");
