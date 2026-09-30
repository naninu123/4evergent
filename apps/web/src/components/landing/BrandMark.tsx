/** 4evergent brand mark: agent loop (outer arc + inner arc). Achromatic stroke. */
export default function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      className="lg-brand-mark"
      width={size}
      height={size}
      viewBox="0 0 26 26"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M13 2a11 11 0 0 1 10.95 9.42 1 1 0 0 1-1.98.34A9 9 0 1 0 21 13H7a6 6 0 0 1 5.95-5.95 1 1 0 0 1 .05 2A5 5 0 1 1 7 13a5.006 5.006 0 0 1 4.9-5 6 6 0 0 1 1.1 0Z"
        fill="currentColor"
        fillOpacity=".86"
      />
    </svg>
  );
}
