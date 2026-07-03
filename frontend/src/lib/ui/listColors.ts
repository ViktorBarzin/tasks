/** Deterministic iOS-palette color per List id (Reminders gives lists colors;
 * CalDAV has one server-side but the contract doesn't carry it — hash instead
 * so each List keeps a stable hue everywhere). */
const PALETTE = [
	'#ff3b30', // red
	'#ff9500', // orange
	'#ffcc00', // yellow
	'#34c759', // green
	'#30b0c7', // teal
	'#007aff', // blue
	'#5856d6', // indigo
	'#af52de', // purple
	'#ff2d55', // pink
	'#a2845e' // brown
];

export function listColor(id: string): string {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
	return PALETTE[Math.abs(hash) % PALETTE.length] as string;
}
