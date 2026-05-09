// SigmaLink monogram — a stylized Σ inside a rounded square. Inline SVG so
// it inherits `currentColor` and scales without a separate asset. Kept
// minimal so it works at 16px (collapsed sidebar) and ~32px (header).

interface Props {
  size?: number;
  className?: string;
  title?: string;
}

export function Monogram({ size = 24, className, title = 'SigmaLink' }: Props) {
  const s = size;
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 32 32"
      role="img"
      aria-label={title}
      className={className}
    >
      <title>{title}</title>
      <rect x="1" y="1" width="30" height="30" rx="7" ry="7" fill="currentColor" opacity="0.12" />
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="7"
        ry="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.55"
      />
      {/* Σ glyph — three strokes (top bar, diagonal slash, bottom bar). */}
      <path
        d="M 9 9 L 23 9 M 9 9 L 17 16 L 9 23 M 9 23 L 23 23"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
