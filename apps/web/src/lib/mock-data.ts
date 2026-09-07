/**
 * Mock data for the dashboard foundation. Every page will swap this for
 * real API calls (via React Query hooks in lib/api.ts) as backend
 * endpoints gain real business logic.
 */

export interface StatSummary {
  label: string;
  value: string;
  delta: string;
  trend: "up" | "down" | "flat";
}

export const dashboardStats: StatSummary[] = [
  { label: "Followers", value: "12,480", delta: "+4.2%", trend: "up" },
  { label: "Engagement rate", value: "6.8%", delta: "+0.6pt", trend: "up" },
  { label: "Posts this week", value: "9", delta: "-2", trend: "down" },
  { label: "Active experiments", value: "3", delta: "0", trend: "flat" },
];

export const growthSeries = [
  { date: "Mon", followers: 12010, engagement: 5.8 },
  { date: "Tue", followers: 12080, engagement: 6.0 },
  { date: "Wed", followers: 12150, engagement: 6.1 },
  { date: "Thu", followers: 12230, engagement: 6.4 },
  { date: "Fri", followers: 12310, engagement: 6.5 },
  { date: "Sat", followers: 12400, engagement: 6.7 },
  { date: "Sun", followers: 12480, engagement: 6.8 },
];

export interface AgentActivityItem {
  id: string;
  runId: string;
  agentName: string;
  decision: string;
  reason: string;
  status: "completed" | "failed" | "running";
  timestamp: string;
}

export const agentActivity: AgentActivityItem[] = [
  {
    id: "1",
    runId: "run_9f21",
    agentName: "research",
    decision: "research_completed",
    reason: "Gathered 3 research result(s) for account demo_account",
    status: "completed",
    timestamp: "2026-09-06T14:02:00Z",
  },
  {
    id: "2",
    runId: "run_9f21",
    agentName: "strategy",
    decision: "strategy_proposed",
    reason: "Focus on short-form debugging/behind-the-scenes content",
    status: "completed",
    timestamp: "2026-09-06T14:02:04Z",
  },
  {
    id: "3",
    runId: "run_9f21",
    agentName: "content_planner",
    decision: "content_idea_planned",
    reason: "Planned one content idea based on current strategy",
    status: "completed",
    timestamp: "2026-09-06T14:02:07Z",
  },
];

export interface ContentItem {
  id: string;
  title: string;
  status: "draft" | "pending_review" | "approved" | "scheduled" | "published" | "rejected";
  platform: "instagram" | "facebook";
  scheduledAt?: string;
}

export const contentItems: ContentItem[] = [
  { id: "c1", title: "3 mistakes killing your reach", status: "published", platform: "instagram" },
  { id: "c2", title: "Behind the scenes: shipping a feature", status: "scheduled", platform: "instagram", scheduledAt: "2026-09-08T09:00:00Z" },
  { id: "c3", title: "Community Q&A recap", status: "pending_review", platform: "facebook" },
  { id: "c4", title: "Weekly growth breakdown", status: "draft", platform: "instagram" },
];

export interface ExperimentItem {
  id: string;
  name: string;
  hypothesis: string;
  status: "draft" | "running" | "completed" | "aborted";
  variants: number;
}

export const experimentItems: ExperimentItem[] = [
  { id: "e1", name: "Caption length test", hypothesis: "Shorter captions increase saves", status: "running", variants: 2 },
  { id: "e2", name: "Posting time shift", hypothesis: "Evening posts outperform morning posts", status: "completed", variants: 2 },
];

export interface SocialAccountItem {
  id: string;
  platform: "instagram" | "facebook";
  displayName: string;
  status: "active" | "disconnected" | "error";
  followers: string;
}

export const socialAccountItems: SocialAccountItem[] = [
  { id: "a1", platform: "instagram", displayName: "@demo_growth_account", status: "active", followers: "12,480" },
  { id: "a2", platform: "facebook", displayName: "Demo Growth Page", status: "disconnected", followers: "3,102" },
];
