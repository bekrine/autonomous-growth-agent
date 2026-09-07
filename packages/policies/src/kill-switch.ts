/**
 * Global and per-account autonomy kill switch. When enabled, all
 * autonomous (non-human-initiated) actions must be denied by the policy
 * layer regardless of what any other policy decides. Backed by an
 * in-memory store here; a production deployment would back this with
 * Postgres/Redis so it can be flipped without a redeploy.
 */
export class KillSwitchStore {
  private globalDisabled: boolean;
  private readonly disabledAccounts = new Set<string>();

  constructor(globalDisabled = false) {
    this.globalDisabled = globalDisabled;
  }

  isGloballyDisabled(): boolean {
    return this.globalDisabled;
  }

  setGlobalDisabled(disabled: boolean): void {
    this.globalDisabled = disabled;
  }

  isAccountDisabled(accountId: string): boolean {
    return this.disabledAccounts.has(accountId);
  }

  setAccountDisabled(accountId: string, disabled: boolean): void {
    if (disabled) this.disabledAccounts.add(accountId);
    else this.disabledAccounts.delete(accountId);
  }

  isDisabled(accountId: string): boolean {
    return this.globalDisabled || this.isAccountDisabled(accountId);
  }
}
