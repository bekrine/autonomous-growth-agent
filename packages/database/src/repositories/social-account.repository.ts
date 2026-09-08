import { eq } from "drizzle-orm";
import type { DrizzleClient } from "../client.js";
import { socialAccounts, users } from "../schema/index.js";

export interface CreateSocialAccountInput {
  userId: string;
  platform: "instagram" | "facebook";
  externalAccountId: string;
  displayName: string;
}

/**
 * Repository layer isolates every SQL/Drizzle detail behind plain methods.
 * Services (and, transitively, agents/tools) depend on this interface, not
 * on Drizzle directly — keeping persistence swappable and testable.
 */
export class SocialAccountRepository {
  constructor(private readonly db: DrizzleClient) {}

  async findById(id: string) {
    const [row] = await this.db.select().from(socialAccounts).where(eq(socialAccounts.id, id));
    return row ?? null;
  }

  async listAll() {
    return this.db.select().from(socialAccounts);
  }

  async create(input: CreateSocialAccountInput) {
    const [row] = await this.db.insert(socialAccounts).values(input).returning();
    return row;
  }

  async ensureDefaultUser(email: string): Promise<string> {
    const [existing] = await this.db.select().from(users).where(eq(users.email, email));
    if (existing) return existing.id;
    const [created] = await this.db.insert(users).values({ email }).returning();
    return created.id;
  }
}
