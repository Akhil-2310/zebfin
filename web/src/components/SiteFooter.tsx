import Link from "next/link";
import { Logo } from "@/components/Logo";

const COLUMNS: [string, [string, string][]][] = [
  [
    "Product",
    [
      ["/#features", "Features"],
      ["/#privacy", "Privacy"],
      ["/#how", "How it works"],
      ["/#zeb", "Meet Zeb"],
    ],
  ],
  [
    "Account",
    [
      ["/signup", "Create a workspace"],
      ["/login", "Sign in with passkey"],
      ["/recover", "Use recovery kit"],
    ],
  ],
];

/** Footer for public pages. */
export function SiteFooter() {
  return (
    <footer className="mt-20 border-t-[3px] border-border bg-surface">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_2fr]">
        <div>
          <Logo className="h-8" />
          <p className="mt-2 max-w-xs text-sm text-muted">
            Private payroll, treasury and books for teams on Zcash. Shielded on chain, encrypted off it.
          </p>
        </div>
        {COLUMNS.map(([title, links]) => (
          <div key={title}>
            <p className="label">{title}</p>
            <ul className="space-y-1.5 text-sm">
              {links.map(([href, label]) => (
                <li key={href}>
                  <Link href={href} className="text-muted hover:text-foreground">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div>
          <p className="label">Honest limits</p>
          <p className="text-xs text-muted">
            Approvals are enforced by our server until threshold signing (FROST) lands. Our view-only wallet service sees
            the payments it builds; moving it into a hardware enclave is planned. Commit-reveal auctions show losing bids
            to participants after close.
          </p>
        </div>
      </div>
      <div className="border-t-2 border-dashed border-border/25">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-muted">
          <span>Zcash testnet only · no real funds</span>
          <span>Built on librustzcash, PCZTs and passkeys</span>
        </div>
      </div>
    </footer>
  );
}
