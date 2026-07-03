<script lang="ts">
	interface Props {
		path: string;
		size?: number;
		stroke?: number;
		filled?: boolean;
	}
	let { path, size = 20, stroke = 2, filled = false }: Props = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill={filled ? 'currentColor' : 'none'}
	stroke={filled ? 'none' : 'currentColor'}
	stroke-width={stroke}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	<path d={path} />
</svg>
