/**
 * Pure geometry for drag-to-reorder (no DOM): where a lifted row lands, how
 * far it may travel, which siblings step aside, and how fast the scroller
 * creeps at the edges. `dragReorder.ts` feeds it content-space row boxes
 * snapshotted at grab time; everything here is unit-tested in isolation.
 *
 * All indices are in the ORIGINAL (pre-drag) row order; `applyReorder`
 * translates a (from, to) pair into the new array.
 */

/** A row's box in content space (scroll-compensated), measured at grab. */
export interface RowBox {
	top: number;
	height: number;
}

/**
 * Target index for a lifted row displaced by `dy` px: the slot whose center is
 * nearest the lifted row's current center. Slots BELOW the origin account for
 * the lifted row leaving the flow (rows in between shift up by the lifted
 * height, so slot t sits at `top(t) + height(t) - lifted height`) — this is
 * the classic off-by-one when dragging down, handled here once. For uniform
 * rows this reduces to "changes index every half row height".
 */
export function targetIndexFor(rows: RowBox[], from: number, dy: number): number {
	const origin = rows[from];
	if (!origin) return from;
	const lifted = origin.top + origin.height / 2 + dy;
	let best = from;
	let bestDist = Infinity;
	for (let t = 0; t < rows.length; t++) {
		const row = rows[t];
		if (!row) continue;
		const slotCenter =
			t >= from ? row.top + row.height - origin.height / 2 : row.top + origin.height / 2;
		const dist = Math.abs(lifted - slotCenter);
		if (dist < bestDist) {
			bestDist = dist;
			best = t;
		}
	}
	return best;
}

/** Clamp `dy` so the lifted row stays between the first row's top and the last row's bottom. */
export function clampDy(rows: RowBox[], from: number, dy: number): number {
	const first = rows[0];
	const last = rows[rows.length - 1];
	const origin = rows[from];
	if (!first || !last || !origin) return dy;
	const lo = first.top - origin.top;
	const hi = last.top + last.height - (origin.top + origin.height);
	return Math.min(hi, Math.max(lo, dy));
}

/**
 * Which way row `index` steps aside while the row at `from` targets `to`:
 * -1 (up one lifted-row height), 1 (down), or 0 (stays). Multiply by the
 * lifted row's height for the translate.
 */
export function siblingShift(index: number, from: number, to: number): -1 | 0 | 1 {
	if (index === from) return 0;
	if (from < to && index > from && index <= to) return -1;
	if (to < from && index >= to && index < from) return 1;
	return 0;
}

/** The array after moving `items[from]` to position `to` (input untouched). */
export function applyReorder<T>(items: readonly T[], from: number, to: number): T[] {
	const next = [...items];
	const [moved] = next.splice(from, 1);
	if (moved !== undefined) next.splice(to, 0, moved);
	return next;
}

/** Edge auto-scroll zone depth (px) and top speed (px per frame). */
const EDGE_ZONE_PX = 56;
const EDGE_MAX_V = 16;

/**
 * Scroll velocity (px/frame) while the pointer sits near the scroller's
 * visible top/bottom edge: 0 outside the zones, accelerating quadratically to
 * ±EDGE_MAX_V at (or beyond) the edge. Zones shrink on small viewports so
 * they never overlap.
 */
export function edgeScrollVelocity(pointerY: number, viewTop: number, viewBottom: number): number {
	const zone = Math.min(EDGE_ZONE_PX, (viewBottom - viewTop) / 3);
	if (zone <= 0) return 0;
	if (pointerY < viewTop + zone) {
		const depth = Math.min(1, (viewTop + zone - pointerY) / zone);
		return -EDGE_MAX_V * depth * depth;
	}
	if (pointerY > viewBottom - zone) {
		const depth = Math.min(1, (pointerY - (viewBottom - zone)) / zone);
		return EDGE_MAX_V * depth * depth;
	}
	return 0;
}
