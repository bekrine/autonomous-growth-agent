"use client";

import { useState } from "react";
import Link from "next/link";
import {
  useInstagramStatus,
  usePublishNow,
  useSchedulePublish,
  type PublishAcceptedDto,
  type PublishDenialDto,
} from "@/lib/api";

/**
 * Publish / schedule controls for an approved content post.
 *
 * Only rendered for content in READY_FOR_PUBLISHING. A policy denial comes
 * back as a structured 409 and is shown inline with its reason rather than
 * being thrown — that's the operator's main feedback channel for "why can't
 * this publish?".
 */
export function PublishActions({
  contentPostId,
  contentStatus,
  accountId,
}: {
  contentPostId: string;
  contentStatus: string;
  accountId: string | null;
}) {
  const statusQuery = useInstagramStatus(accountId);
  const publishNow = usePublishNow();
  const schedule = useSchedulePublish();
  const [scheduledFor, setScheduledFor] = useState("");
  const [outcome, setOutcome] = useState<PublishAcceptedDto | PublishDenialDto | null>(null);

  const igStatus = statusQuery.data;
  const connectionId = igStatus?.connectionId;
  const ready = contentStatus === "ready_for_publishing";

  if (!ready) {
    return (
      <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
        <h3 className="mb-2 text-xs uppercase tracking-wide text-white/40">Publishing</h3>
        <p className="text-sm text-white/50">
          {contentStatus === "published"
            ? "This content has been published."
            : `Publishing becomes available once this content reaches READY_FOR_PUBLISHING (currently ${contentStatus.replace(/_/g, " ")}).`}
        </p>
      </div>
    );
  }

  if (!igStatus?.connected || !connectionId) {
    return (
      <div className="rounded-xl border border-surface-border bg-surface-raised p-5">
        <h3 className="mb-2 text-xs uppercase tracking-wide text-white/40">Publishing</h3>
        <p className="text-sm text-white/70">Instagram connection required</p>
        <Link
          href="/social-accounts"
          className="mt-3 inline-block rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400"
        >
          Connect Instagram
        </Link>
      </div>
    );
  }

  async function handlePublishNow() {
    setOutcome(await publishNow.mutateAsync({ contentPostId, socialConnectionId: connectionId! }));
  }

  async function handleSchedule() {
    if (!scheduledFor) return;
    setOutcome(
      await schedule.mutateAsync({
        contentPostId,
        socialConnectionId: connectionId!,
        scheduledFor: new Date(scheduledFor).toISOString(),
      }),
    );
  }

  const denied = outcome && "allowed" in outcome && outcome.allowed === false;
  const accepted = outcome && "accepted" in outcome && outcome.accepted;
  const busy = publishNow.isPending || schedule.isPending;

  return (
    <div className="space-y-3 rounded-xl border border-surface-border bg-surface-raised p-5">
      <h3 className="text-xs uppercase tracking-wide text-white/40">Publishing</h3>
      <p className="text-sm text-white/60">
        Target: <span className="text-white">@{igStatus.username ?? "instagram"}</span>
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void handlePublishNow()}
          disabled={busy}
          className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
        >
          {publishNow.isPending ? "Queueing…" : "Publish Now"}
        </button>

        <input
          type="datetime-local"
          value={scheduledFor}
          onChange={(e) => setScheduledFor(e.target.value)}
          className="rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-white"
        />
        <button
          onClick={() => void handleSchedule()}
          disabled={busy || !scheduledFor}
          className="rounded-md border border-surface-border px-4 py-2 text-sm text-white/80 transition-colors hover:bg-white/5 disabled:opacity-50"
        >
          {schedule.isPending ? "Scheduling…" : "Schedule"}
        </button>
      </div>

      {denied ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3">
          <p className="text-sm font-medium text-rose-400">Publishing unavailable</p>
          <p className="text-sm text-white/70">Reason: {(outcome as PublishDenialDto).reason}</p>
        </div>
      ) : null}

      {accepted ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <p className="text-sm text-emerald-400">
            Queued as {(outcome as PublishAcceptedDto).status}.{" "}
            <Link href="/publishing" className="underline">
              Track it in Publishing
            </Link>
          </p>
        </div>
      ) : null}

      {publishNow.isError || schedule.isError ? (
        <p className="text-sm text-rose-400">
          {((publishNow.error ?? schedule.error) as Error).message}
        </p>
      ) : null}
    </div>
  );
}
