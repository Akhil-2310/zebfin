/* eslint-disable @next/next/no-img-element */
/** Zebfin's logo: Zeb's badge plus the pixel wordmark (light/dark variants). */
export function Logo({ className = "h-7" }: { className?: string }) {
  return (
    <>
      <img src="/brand/zebfin-logo.svg" alt="Zebfin" className={`${className} w-auto dark:hidden`} />
      <img src="/brand/zebfin-logo-dark.svg" alt="Zebfin" className={`${className} hidden w-auto dark:block`} />
    </>
  );
}
