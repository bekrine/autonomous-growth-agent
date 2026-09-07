import type { ContentRepository } from "@agent/database";

export class ContentService {
  constructor(private readonly repo: ContentRepository) {}

  async listPosts() {
    return this.repo.listPosts();
  }

  async createPost(input: {
    socialAccountId: string;
    contentIdeaId?: string;
    caption?: string;
    mediaUrls?: string[];
  }) {
    return this.repo.createPost(input);
  }
}
