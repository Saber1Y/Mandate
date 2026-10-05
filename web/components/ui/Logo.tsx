/**
 * Mandate mark.
 *
 * The product is a bounded allowance around something that acts on its own. So: an agent (the filled
 * dot) held inside a boundary (the ring) that is deliberately open on one side - the only exit, and
 * the only thing standing between autonomy and an unbounded treasury.
 *
 * Drawn as inline SVG rather than shipped as a bitmap so it stays crisp at any size, inherits
 * `currentColor`, and cannot drift from the wordmark. The favicon raster in app/icon.png is rendered
 * from this same geometry by scripts/render-icon.mjs.
 */
export function Mark({size = 28, className = ""}: {size?: number; className?: string}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Mandate"
      className={className}
    >
      {/* Boundary: a near-complete ring with a single gated opening at the lower right. */}
      <path
        d="M25.6 20.2A10.4 10.4 0 1 1 20.2 25.6"
        stroke="currentColor"
        strokeWidth="3.1"
        strokeLinecap="round"
      />
      {/* The agent. */}
      <circle cx="16" cy="16" r="4.1" fill="currentColor" />
    </svg>
  );
}

/** Mark plus wordmark, for the nav and footer. */
export function Logo({height = 28, className = ""}: {height?: number; className?: string}) {
  return (
    <span className={`inline-flex select-none items-center gap-2 ${className}`}>
      <span style={{color: "var(--color-accent)"}}>
        <Mark size={height * 0.92} />
      </span>
      <span
        className="font-sans text-text-primary"
        style={{
          fontSize: height * 0.62,
          fontWeight: 600,
          letterSpacing: "-0.03em",
          lineHeight: 1,
        }}
      >
        Mandate
      </span>
    </span>
  );
}