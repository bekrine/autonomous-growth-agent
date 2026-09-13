/**
 * Deterministic, balanced assignment of content slots to experiment arms.
 *
 * Naively publishing all controls first and all variants later makes time
 * itself the variable: a difference in results could be the arm, or it could
 * be the day, the hour, or an algorithm change in between. Interleaving the
 * arms spreads each one evenly across the publishing schedule so time affects
 * both equally.
 *
 * Assignment is a pure function of the slot index, not random, so an
 * experiment's schedule can be reproduced exactly from its configuration.
 */

export interface AssignableVariant {
  id: string;
  name: string;
  role: "control" | "variant";
  status?: string;
}

export interface SlotAssignment {
  slot: number;
  variantId: string;
  variantName: string;
  role: "control" | "variant";
}

/**
 * Round-robin over the active arms:
 *
 *   slot 0 -> control, slot 1 -> variant, slot 2 -> control, ...
 *
 * With three arms it cycles through all three before repeating, so every arm
 * gets an equal share of early and late slots.
 */
export function assignSlots(variants: AssignableVariant[], slotCount: number): SlotAssignment[] {
  const active = variants.filter((v) => (v.status ?? "active") === "active");
  if (active.length === 0 || slotCount <= 0) return [];

  // Control first, then variants in stable name order: the cycle must not
  // depend on the order rows happened to come back from the database.
  const ordered = [...active].sort((a, b) => {
    if (a.role !== b.role) return a.role === "control" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return Array.from({ length: slotCount }, (_, slot) => {
    const variant = ordered[slot % ordered.length]!;
    return { slot, variantId: variant.id, variantName: variant.name, role: variant.role };
  });
}

/**
 * How many slots are still owed to each arm to reach the target.
 *
 * Used when an experiment is resumed or partially published: rather than
 * restarting the cycle, it tops up whichever arms are behind, which keeps the
 * arms balanced even after a failure.
 */
export function remainingSlots(
  variants: AssignableVariant[],
  publishedPerVariant: Record<string, number>,
  targetPerVariant: number,
): { variantId: string; variantName: string; role: "control" | "variant"; needed: number }[] {
  return variants
    .filter((v) => (v.status ?? "active") === "active")
    .map((variant) => ({
      variantId: variant.id,
      variantName: variant.name,
      role: variant.role,
      needed: Math.max(0, targetPerVariant - (publishedPerVariant[variant.id] ?? 0)),
    }))
    .filter((entry) => entry.needed > 0);
}

/**
 * Interleaves the outstanding slots so the arm that is furthest behind goes
 * first, rather than emitting all of one arm's remaining posts consecutively.
 */
export function buildBalancedQueue(
  variants: AssignableVariant[],
  publishedPerVariant: Record<string, number>,
  targetPerVariant: number,
): SlotAssignment[] {
  const remaining = remainingSlots(variants, publishedPerVariant, targetPerVariant);
  const counts = new Map(remaining.map((entry) => [entry.variantId, entry.needed]));
  const running = new Map(remaining.map((entry) => [entry.variantId, publishedPerVariant[entry.variantId] ?? 0]));

  const queue: SlotAssignment[] = [];
  let slot = 0;

  while ([...counts.values()].some((n) => n > 0)) {
    // Pick the arm with the fewest posts so far; ties break on name for determinism.
    const candidates = remaining
      .filter((entry) => (counts.get(entry.variantId) ?? 0) > 0)
      .sort((a, b) => {
        const diff = (running.get(a.variantId) ?? 0) - (running.get(b.variantId) ?? 0);
        return diff !== 0 ? diff : a.variantName.localeCompare(b.variantName);
      });

    const next = candidates[0]!;
    queue.push({ slot, variantId: next.variantId, variantName: next.variantName, role: next.role });
    counts.set(next.variantId, (counts.get(next.variantId) ?? 0) - 1);
    running.set(next.variantId, (running.get(next.variantId) ?? 0) + 1);
    slot += 1;
  }

  return queue;
}
