/**
 * Poll-diff detector: compare two aggregate snapshots and emit one
 * `StateChange` per (customer, bridge) cell whose status `kind` transitioned.
 *
 * Design choices:
 *  - `prev === null` (first tick ever) yields no changes — it only establishes
 *    a baseline, so the engine does not fire an alert-storm on boot.
 *  - Newly-appeared rows/cells are skipped: there is no prior state to diff
 *    against, so we wait for the next tick to observe their transitions.
 *  - Iterates `Object.entries(cells)` rather than hardcoding bridge keys, so it
 *    keeps working as new bridges (sophos/securepoint/m365) join the cell type.
 *
 * @module @domains/automation/state-diff
 */
import type { AggregateSnapshot } from '../msp-aggregate/types.js';

export interface StateChange {
  readonly slug: string;
  readonly bridge: string;
  readonly from: string;
  readonly to: string;
}

type CellMap = Record<string, { readonly kind: string } | undefined>;

export function diffSnapshots(
  prev: AggregateSnapshot | null,
  current: AggregateSnapshot,
): StateChange[] {
  if (prev === null) {
    return [];
  }

  const prevRows = new Map(prev.rows.map((row) => [row.slug, row.cells as CellMap]));
  const changes: StateChange[] = [];

  for (const row of current.rows) {
    const prevCells = prevRows.get(row.slug);
    if (prevCells === undefined) {
      continue; // new customer row — no baseline yet
    }
    for (const [bridge, cell] of Object.entries(row.cells as CellMap)) {
      if (cell === undefined) {
        continue;
      }
      const prevCell = prevCells[bridge];
      if (prevCell === undefined) {
        continue; // new cell — no baseline yet
      }
      if (prevCell.kind !== cell.kind) {
        changes.push({ slug: row.slug, bridge, from: prevCell.kind, to: cell.kind });
      }
    }
  }

  return changes;
}
