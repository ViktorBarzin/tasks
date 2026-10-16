interface IconProps {
	path: string;
	size?: number;
	stroke?: number;
	filled?: boolean;
}

/** A single-path 24×24 stroke icon (the Svelte build's Icon.svelte). */
export function Icon({
	path,
	size = 20,
	stroke = 2,
	filled = false,
}: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill={filled ? "currentColor" : "none"}
			stroke={filled ? "none" : "currentColor"}
			strokeWidth={stroke}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d={path} />
		</svg>
	);
}
