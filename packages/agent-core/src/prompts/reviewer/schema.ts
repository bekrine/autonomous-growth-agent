import { z } from "zod";

export const ReviewIssueSchema = z.object({
  type: z.enum(["quality", "brand", "safety", "accuracy", "duplication", "platform_readiness"]),
  message: z.string().min(1),
});

export const ReviewResultSchema = z.object({
  approved: z.boolean(),
  score: z.number().min(0).max(1),
  qualityScore: z.number().min(0).max(1),
  brandScore: z.number().min(0).max(1),
  safetyScore: z.number().min(0).max(1),
  issues: z.array(ReviewIssueSchema),
  warnings: z.array(z.string()),
  recommendedChanges: z.array(z.string()),
});

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
