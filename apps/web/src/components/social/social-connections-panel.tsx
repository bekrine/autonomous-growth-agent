"use client";

import { useState } from "react";
import {
  useAccounts,
  useConnectInstagram,
  useDisconnectConnection,
  useInstagramStatus,
} from "@/lib/api";
import { StatusBadge } from "@/components/ui/status-badge";

/**
 * Instagram connection management. Tokens are never fetched or rendered —
 * the API only ever returns the safe projection (username, account type,
 * status, expiry).
 */
export function SocialConnectionsPanel() {
  const accountsQuery = useAccounts();
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const connect = useConnectInstagram();
  const disconnect = useDisconnectConnection();

  const accounts = accountsQuery.data ?? [];
  const accountId = selectedAccountId || accounts[0]?.id || "";
  const statusQuery = useInstagramStatus(accountId || null);
  const status = statusQuery.data;

  async function handleConnect() {
    if (!accountId) return;
    const { authorizationUrl } = await connect.mutateAsync(accountId);
    // Full navigation: the OAuth consent screen must run in the top-level window.
    window.location.href = authorizationUrl;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-surface-border bg-surface-raised p-5">
        <select
          value={accountId}
          onChange={(e) => setSelectedAccountId(e.target.value)}
          className="rounded-md border border-surface-border bg-surface px-3 py-2 text-sm text-white"
        >
          {accounts.length === 0 ? <option value="">No accounts yet</option> : null}
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-xl border border-surface-border bg-surface-raised p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-medium text-white">Instagram</h2>
          {status?.connected ? <StatusBadge status={status.healthy ? "connected" : "error"} /> : null}
        </div>

        {!status ? (
          <p className="text-sm text-white/40">Loading connection status…</p>
        ) : !status.configured ? (
          <div className="space-y-2">
            <p className="text-sm text-white/70">Instagram integration is not configured on this server.</p>
            <p className="text-xs text-white/40">
              Set <code className="text-white/60">META_APP_ID</code>,{" "}
              <code className="text-white/60">META_APP_SECRET</code> and{" "}
              <code className="text-white/60">TOKEN_ENCRYPTION_KEY</code>, then restart the API. See{" "}
              <code className="text-white/60">docs/instagram-setup.md</code>.
            </p>
          </div>
        ) : status.connected ? (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-white/30">Connection</dt>
                <dd className="text-white">{status.healthy ? "Connected" : "Needs attention"}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-white/30">Account</dt>
                <dd className="text-white">@{status.username ?? "unknown"}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-white/30">Type</dt>
                <dd className="capitalize text-white">{status.accountType ?? "unknown"}</dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-white/30">Status</dt>
                <dd className="capitalize text-white">{status.status ?? "unknown"}</dd>
              </div>
            </dl>

            {status.tokenExpiresAt ? (
              <p className="text-xs text-white/40">
                Access expires {new Date(status.tokenExpiresAt).toLocaleString()}
              </p>
            ) : null}

            {!status.healthy ? (
              <p className="text-sm text-amber-400">
                This connection needs to be re-authorized before publishing will work.
              </p>
            ) : null}

            <button
              onClick={() => status.connectionId && void disconnect.mutateAsync(status.connectionId)}
              disabled={disconnect.isPending}
              className="rounded-md border border-surface-border px-4 py-2 text-sm text-white/80 transition-colors hover:bg-white/5 disabled:opacity-50"
            >
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-white/60">Connection: NOT CONNECTED</p>
            <p className="text-xs text-white/40">
              Requires an Instagram Professional (Business or Creator) account linked to a Facebook Page.
            </p>
            <button
              onClick={() => void handleConnect()}
              disabled={!accountId || connect.isPending}
              className="rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-50"
            >
              {connect.isPending ? "Redirecting…" : "Connect Instagram"}
            </button>
            {connect.isError ? (
              <p className="text-sm text-rose-400">{(connect.error as Error).message}</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
