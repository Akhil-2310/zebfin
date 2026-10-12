import Link from "next/link";
import { Pet } from "@/components/Pet";

const LINKS = [
  ["/#privacy", "Privacy"],
  ["/#features", "Features"],
  ["/#how", "How it works"],
  ["/#zeb", "Meet Zeb"],
] as const;

/** Top navigation for public pages. */
export function SiteNav() {
  return (
    <header className="sticky top-0 z-20 border-b-[3px] border-border bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
          <Pet mood="happy" size={30} />
          <span className="pixel text-lg font-bold tracking-wide">ZEBFIN</span>
        </Link>
        <nav className="hidden items-center gap-6 text-sm md:flex" aria-label="Page sections">
          {LINKS.map(([href, label]) => (
            <a key={href} href={href} className="display text-muted hover:text-foreground">
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/login" className="btn-ghost px-3 py-1.5 text-sm">
            Sign in
          </Link>
          <Link href="/signup" className="btn hidden px-4 py-1.5 text-sm sm:inline-flex">
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
