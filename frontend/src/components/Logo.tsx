import logoUrl from "../assets/images/strata_logo.svg";

// Strata's mark — see assets/images/strata_logo.svg for the source. Kept
// as a plain <img> rather than inlined JSX: the file is a few hundred KB
// of hand-illustrated path data, and inlining it would mean shipping that
// as parsed JS on every render instead of one image request the browser
// caches like any other asset.
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return <img src={logoUrl} width={size} height={size} alt="" className={className} />;
}
