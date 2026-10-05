/** Mandate wordmark - pure type. Weight 600, tight tracking. */
export function Wordmark({className = "", tone = "dark"}: {className?: string; tone?: "dark" | "light"}) {
  return (
    <span
      className={`font-sans select-none ${tone === "light" ? "text-white" : "text-text-primary"} ${className}`}
      style={{fontWeight: 600, letterSpacing: "-0.03em"}}
    >
      Mand<span className="text-accent">ate</span>
    </span>
  );
}
