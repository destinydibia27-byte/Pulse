/**
 * The Volo mark: two slanted bars. Geometry is taken from the supplied logo and verified
 * against its pixels (98.8% overlap), so it stays crisp at any size.
 */
export function LogoMark({ className = "h-8 w-auto" }: { className?: string }) {
  return (
    <svg viewBox="592 404 767 883" className={className} fill="currentColor" aria-hidden="true">
      <polygon points="592,645 805,645 1019,1287 805,1287" />
      <polygon points="1144,404 1359,404 1146,1045 935,1045" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark className="h-7 w-auto text-link" />
      <span className="text-xl font-bold tracking-tight text-navy">Volo</span>
    </span>
  );
}
