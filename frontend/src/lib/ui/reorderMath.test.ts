import { describe, expect, it } from 'vitest';

import {
	applyReorder,
	clampDy,
	edgeScrollVelocity,
	siblingShift,
	targetIndexFor,
	type RowBox
} from './reorderMath';

/** n uniform rows of height h stacked from `top`. */
function uniform(n: number, h = 50, top = 0): RowBox[] {
	return Array.from({ length: n }, (_, i) => ({ top: top + i * h, height: h }));
}

describe('targetIndexFor', () => {
	const rows = uniform(5); // tops 0,50,100,150,200

	it('zero displacement is a no-op for every origin', () => {
		for (let from = 0; from < rows.length; from++) {
			expect(targetIndexFor(rows, from, 0)).toBe(from);
		}
	});

	it('tiny jitter (below half a row) never changes the index', () => {
		for (let from = 0; from < rows.length; from++) {
			expect(targetIndexFor(rows, from, 10)).toBe(from);
			expect(targetIndexFor(rows, from, -10)).toBe(from);
			expect(targetIndexFor(rows, from, 24)).toBe(from);
			expect(targetIndexFor(rows, from, -24)).toBe(from);
		}
	});

	it('crossing half a row height moves exactly one step', () => {
		expect(targetIndexFor(rows, 0, 26)).toBe(1);
		expect(targetIndexFor(rows, 2, 26)).toBe(3);
		expect(targetIndexFor(rows, 2, -26)).toBe(1);
		expect(targetIndexFor(rows, 4, -26)).toBe(3);
	});

	it('drag down N steps: each slot is claimed at its nearest center', () => {
		expect(targetIndexFor(rows, 0, 76)).toBe(2); // 1.52 rows
		expect(targetIndexFor(rows, 0, 126)).toBe(3);
		expect(targetIndexFor(rows, 1, 149)).toBe(4); // 2.98 rows
	});

	it('drag up N steps mirrors drag down', () => {
		expect(targetIndexFor(rows, 4, -76)).toBe(2);
		expect(targetIndexFor(rows, 4, -126)).toBe(1);
		expect(targetIndexFor(rows, 3, -149)).toBe(0);
	});

	it('clamps at the top and bottom edges (overshoot lands on the end rows)', () => {
		expect(targetIndexFor(rows, 0, -500)).toBe(0);
		expect(targetIndexFor(rows, 4, 500)).toBe(4);
		expect(targetIndexFor(rows, 2, 10_000)).toBe(4);
		expect(targetIndexFor(rows, 2, -10_000)).toBe(0);
	});

	it('roundtrip: dy of exactly (t - from) rows lands on t, for every pair', () => {
		const six = uniform(6, 44, 120);
		for (let from = 0; from < 6; from++) {
			for (let t = 0; t < 6; t++) {
				expect(targetIndexFor(six, from, (t - from) * 44)).toBe(t);
			}
		}
	});

	it('accounts for the lifted row leaving the flow with non-uniform heights', () => {
		// heights 40,80,40,60 — dragging the 40px row 0 down past the 80px row 1:
		// the slot below sits at top(1)+height(1)-40, so its center is crossed at
		// dy = 40 (NOT at half of row 1's own height).
		const rows2: RowBox[] = [
			{ top: 0, height: 40 },
			{ top: 40, height: 80 },
			{ top: 120, height: 40 },
			{ top: 160, height: 60 }
		];
		expect(targetIndexFor(rows2, 0, 39)).toBe(0);
		expect(targetIndexFor(rows2, 0, 41)).toBe(1);
		// Dragging the 80px row 1 up over the 40px row 0: slot 0 center is
		// top(0) + 80/2 = 40, own center 80 — boundary at dy = -20.
		expect(targetIndexFor(rows2, 1, -19)).toBe(1);
		expect(targetIndexFor(rows2, 1, -21)).toBe(0);
	});

	it('a single row can only stay put', () => {
		expect(targetIndexFor(uniform(1), 0, 300)).toBe(0);
		expect(targetIndexFor(uniform(1), 0, -300)).toBe(0);
	});
});

describe('clampDy', () => {
	const rows = uniform(5); // content spans 0..250

	it('keeps the lifted row inside the list bounds', () => {
		expect(clampDy(rows, 0, -10)).toBe(0);
		expect(clampDy(rows, 0, 500)).toBe(200);
		expect(clampDy(rows, 4, 10)).toBe(0);
		expect(clampDy(rows, 4, -500)).toBe(-200);
		expect(clampDy(rows, 2, 60)).toBe(60);
		expect(clampDy(rows, 2, -60)).toBe(-60);
	});

	it('respects non-uniform heights (bottom bound uses the last row bottom)', () => {
		const rows2: RowBox[] = [
			{ top: 100, height: 40 },
			{ top: 140, height: 80 },
			{ top: 220, height: 40 }
		];
		expect(clampDy(rows2, 0, -50)).toBe(0);
		expect(clampDy(rows2, 0, 999)).toBe(120); // 260 - 140
		expect(clampDy(rows2, 2, 999)).toBe(0);
		expect(clampDy(rows2, 2, -999)).toBe(-120);
	});
});

describe('siblingShift', () => {
	it('matches the full matrix for a 4-row list', () => {
		// [index] → expected shift for each (from, to).
		const cases: { from: number; to: number; shifts: number[] }[] = [
			{ from: 0, to: 0, shifts: [0, 0, 0, 0] },
			{ from: 0, to: 1, shifts: [0, -1, 0, 0] },
			{ from: 0, to: 3, shifts: [0, -1, -1, -1] },
			{ from: 3, to: 3, shifts: [0, 0, 0, 0] },
			{ from: 3, to: 1, shifts: [0, 1, 1, 0] },
			{ from: 3, to: 0, shifts: [1, 1, 1, 0] },
			{ from: 1, to: 2, shifts: [0, 0, -1, 0] },
			{ from: 2, to: 1, shifts: [0, 1, 0, 0] }
		];
		for (const { from, to, shifts } of cases) {
			for (let i = 0; i < 4; i++) {
				expect(siblingShift(i, from, to), `i=${i} from=${from} to=${to}`).toBe(shifts[i]);
			}
		}
	});

	it('the lifted row itself never shifts', () => {
		for (let from = 0; from < 5; from++) {
			for (let to = 0; to < 5; to++) {
				expect(siblingShift(from, from, to)).toBe(0);
			}
		}
	});
});

describe('applyReorder', () => {
	const items = ['a', 'b', 'c', 'd', 'e'];

	it('moves an item down (indices in the ORIGINAL array)', () => {
		expect(applyReorder(items, 0, 3)).toEqual(['b', 'c', 'd', 'a', 'e']);
	});

	it('moves an item up', () => {
		expect(applyReorder(items, 4, 1)).toEqual(['a', 'e', 'b', 'c', 'd']);
	});

	it('adjacent swaps work both ways', () => {
		expect(applyReorder(items, 1, 2)).toEqual(['a', 'c', 'b', 'd', 'e']);
		expect(applyReorder(items, 2, 1)).toEqual(['a', 'c', 'b', 'd', 'e']);
	});

	it('from === to returns the same order', () => {
		expect(applyReorder(items, 2, 2)).toEqual(items);
	});

	it('never mutates the input', () => {
		const input = ['x', 'y', 'z'];
		applyReorder(input, 0, 2);
		expect(input).toEqual(['x', 'y', 'z']);
	});
});

describe('edgeScrollVelocity', () => {
	// Scroller viewport 100..800, default zone/velocity.
	it('is zero away from both edges', () => {
		expect(edgeScrollVelocity(450, 100, 800)).toBe(0);
		expect(edgeScrollVelocity(100 + 56, 100, 800)).toBe(0);
		expect(edgeScrollVelocity(800 - 56, 100, 800)).toBe(0);
	});

	it('accelerates quadratically into the top zone (negative = scroll up)', () => {
		const half = edgeScrollVelocity(100 + 28, 100, 800);
		const full = edgeScrollVelocity(100, 100, 800);
		expect(half).toBeLessThan(0);
		expect(full).toBeLessThan(half);
		expect(full / half).toBeCloseTo(4, 5); // depth² : (1 / 0.5²)
	});

	it('mirrors into the bottom zone (positive = scroll down)', () => {
		expect(edgeScrollVelocity(800 - 28, 100, 800)).toBeGreaterThan(0);
		expect(edgeScrollVelocity(800, 100, 800)).toBeCloseTo(
			-edgeScrollVelocity(100, 100, 800),
			5
		);
	});

	it('clamps beyond the viewport to max velocity', () => {
		expect(edgeScrollVelocity(0, 100, 800)).toBe(edgeScrollVelocity(100, 100, 800));
		expect(edgeScrollVelocity(999, 100, 800)).toBe(edgeScrollVelocity(800, 100, 800));
	});

	it('shrinks the zones when the viewport is small so they never overlap', () => {
		// 90px viewport: zones become 30px each.
		expect(edgeScrollVelocity(145, 100, 190)).toBe(0);
		expect(edgeScrollVelocity(129, 100, 190)).toBeLessThan(0);
		expect(edgeScrollVelocity(161, 100, 190)).toBeGreaterThan(0);
	});
});
