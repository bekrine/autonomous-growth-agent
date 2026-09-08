import { loadEnv } from "@agent/shared";
import { createDatabase, closeDatabase } from "./client.js";
import { SocialAccountRepository } from "./repositories/social-account.repository.js";
import { AgentProfileRepository } from "./repositories/agent-profile.repository.js";

/**
 * Development-only fixture: one realistic account with a niche, audience
 * and goal so `POST /api/agent/runs` has something runnable immediately
 * after `docker compose up`. Idempotent — re-running finds the account by
 * its fixed externalAccountId instead of creating duplicates. Never
 * invoked by production code paths; run it manually (`npm run db:seed
 * --workspace=@agent/database`) or not at all.
 */
const SEED_EXTERNAL_ACCOUNT_ID = "seed_ai_dev_growth_lab";

async function main() {
  const env = loadEnv();
  const db = createDatabase(env.DATABASE_URL);
  const accounts = new SocialAccountRepository(db);
  const profiles = new AgentProfileRepository(db);

  const existing = (await accounts.listAll()).find((a) => a.externalAccountId === SEED_EXTERNAL_ACCOUNT_ID);
  if (existing) {
    // eslint-disable-next-line no-console
    console.log(`Seed account already exists: ${existing.id}`);
    await closeDatabase();
    return;
  }

  const userId = await accounts.ensureDefaultUser("seed-dev@example.com");
  const account = await accounts.create({
    userId,
    platform: "instagram",
    externalAccountId: SEED_EXTERNAL_ACCOUNT_ID,
    displayName: "AI Developer Growth Lab",
  });

  const profile = await profiles.create({
    socialAccountId: account.id,
    niche: "AI and developer productivity",
    audienceDescription: "Developers interested in AI tools",
    tone: "practical, direct, a little informal",
  });

  await profiles.createGoal({
    agentProfileId: profile.id,
    title: "Grow an educational social-media account",
    metric: "followers",
    targetValue: 10000,
  });

  // eslint-disable-next-line no-console
  console.log(`Seed account created: ${account.id}`);
  await closeDatabase();
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Seed failed:", error);
  process.exit(1);
});
