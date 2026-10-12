import Link from "next/link";
import { Pet } from "@/components/Pet";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteNav } from "@/components/SiteNav";
import { petLine, type Mood } from "@/lib/pet";

const comparison = [
  ["Who you pay and how much", "Public to anyone", "Encrypted on chain"],
  ["Each person's salary", "Visible to every employee", "Only in their own wallet"],
  ["Team size from payroll", "Count the outputs", "Padded to buckets of 8"],
  ["Treasury balance", "Public", "Shielded"],
  ["Your books and contributor list", "On a vendor's server", "Encrypted in your browser"],
  ["Sealed bids", "Readable by the organizer", "Committed; unreadable until close"],
] as const;

const moods: [Mood, string, string][] = [
  ["egg", "Egg", "No treasury yet"],
  ["hungry", "Hungry", "Balance is empty"],
  ["payday", "Pay day", "Payroll is due"],
  ["busy", "Busy", "Payments need approval"],
  ["sick", "Unwell", "A payment failed"],
  ["party", "Party", "A payment just confirmed"],
];

const badges = ["🛡️ Shielded on Zcash", "🔐 End-to-end encrypted", "🔑 Passkeys, no passwords", "🧾 Books & exports"];

const modules = [
  ["💸 Payroll", "One shielded transaction pays everyone; payslips ride in encrypted memos. USD salaries at a locked rate."],
  ["🏦 Treasury", "Payment requests, spending policy, payee book, invoices with QR codes, scoped auditor links."],
  ["📒 Books", "A ledger built in your browser from your viewing keys. Reconciliation, reports, QuickBooks/Xero exports."],
  ["💖 Kudos", "Teammates thank each other with small amounts. Leaderboards count; nobody sees anyone else's amounts."],
  ["🔨 Auctions", "Sealed-bid procurement and sales with on-chain commit-reveal. Anyone can bid from a link with any shielded wallet."],
] as const;

const steps = [
  ["Passkey, not passwords", "Your passkey unlocks an organization key generated in your browser. We never see it."],
  ["Request and approve", "Anyone requests a payment; approvers approve with their passkeys under your spending policy."],
  ["Sign on your device", "Our server builds and proves the transaction with a view-only key. Only an approver's device can sign."],
  ["Shielded on Zcash", "The payment goes out as an Orchard-protocol shielded transaction at a randomized time."],
] as const;

export default function Home() {
  return (
    <>
      <SiteNav />
      <main className="flex-1">
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-12 sm:pt-20 md:grid-cols-[1.25fr_1fr]">
          <div>
            <span className="chip chip-sun">Private finance on Zcash</span>
            <h1 className="mt-5 text-4xl leading-[1.1] sm:text-6xl">
              Run your team&apos;s money <span className="text-accent-ink">without publishing it.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-muted">
              Payroll, treasury and books for startups, small businesses and grant programs, or just for you. On public chains your salaries, balances
              and vendors are visible to anyone. On Zebfin they&apos;re shielded on chain and encrypted off it.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/signup" className="btn px-6 py-3 text-base">
                🥚 Hatch your workspace
              </Link>
              <a href="#how" className="btn-ghost px-6 py-3 text-base">
                See how it works
              </a>
            </div>
            <ul className="mt-8 flex flex-wrap gap-2 text-xs">
              {badges.map((b) => (
                <li key={b} className="chip">
                  {b}
                </li>
              ))}
            </ul>
          </div>

          {/* The handheld: a toy shell with an LCD, Zeb inside, and three buttons. */}
          <div
            className="card mx-auto w-full max-w-xs px-8 pb-10 pt-12 text-center"
            style={{ background: "var(--accent-soft)", borderRadius: "46% 46% 40% 40% / 34% 34% 30% 30%" }}
            aria-label="Zeb, the Zebfin treasury pet"
          >
            <p className="pixel text-xs tracking-[0.3em] text-muted">ZEBFIN</p>
            <div className="screen mt-3 flex flex-col items-center gap-2 pb-3 pt-6">
              <Pet mood="happy" size={112} />
              <p className="text-[11px] leading-tight">{petLine("happy", 1)}</p>
            </div>
            <div className="mt-6 flex justify-center gap-5" aria-hidden>
              {["var(--sun)", "var(--mint)", "var(--sky)"].map((c) => (
                <span key={c} className="h-8 w-8 rounded-full border-[3px] border-border" style={{ background: c, boxShadow: "var(--shadow-sm)" }} />
              ))}
            </div>
          </div>
        </section>

        {/* Privacy comparison */}
        <section id="privacy" className="scroll-mt-20 border-y-[3px] border-border bg-surface py-16">
          <div className="mx-auto max-w-6xl px-4">
            <SectionTitle eyebrow="Privacy" title="Public chain vs. Zebfin" blurb="What the world can see about your organization's money." />
            <div className="card mt-8">
              {/* Phones: stacked rows, so the Zebfin column is never off-screen. */}
              <ul className="space-y-3 text-sm sm:hidden">
                {comparison.map(([what, pub, zeb]) => (
                  <li key={what} className="border-b-2 border-dashed border-border/25 pb-3 last:border-0 last:pb-0">
                    <p className="font-bold">{what}</p>
                    <p className="text-muted">👀 Public chain: {pub}</p>
                    <p>
                      <span className="font-bold text-accent-ink">🔒 Zebfin:</span> {zeb}
                    </p>
                  </li>
                ))}
              </ul>
              <table className="hidden w-full text-sm sm:table">
                <thead className="display text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="py-2 font-medium"> </th>
                    <th className="font-medium">👀 On a public chain</th>
                    <th className="font-medium text-accent-ink">🔒 With Zebfin</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.map(([what, pub, zeb]) => (
                    <tr key={what}>
                      <td className="py-3 pr-4 font-bold">{what}</td>
                      <td className="pr-4 text-muted">{pub}</td>
                      <td>{zeb}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16">
          <SectionTitle eyebrow="Features" title="One app, five modules" blurb="Everything a small team needs to pay people and keep the books, privately." />
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {modules.map(([title, body]) => (
              <div key={title} className="card">
                <h3 className="text-lg">{title}</h3>
                <p className="mt-2 text-sm text-muted">{body}</p>
              </div>
            ))}
            <div className="card" style={{ background: "var(--sun)", color: "#2a2036" }}>
              <h3 className="text-lg">📅 Pay day reminders</h3>
              <p className="mt-2 text-sm">
                Set a monthly pay day. Zeb reminds your approvers and fills in the run; your passkeys still sign it.
              </p>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="scroll-mt-20 border-y-[3px] border-border bg-surface py-16">
          <div className="mx-auto max-w-6xl px-4">
            <SectionTitle eyebrow="How it works" title="From request to shielded payment" />
            <ol className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map(([title, body], i) => (
                <li key={title} className="card">
                  <span className="display grid h-9 w-9 place-items-center rounded-xl border-[3px] border-border bg-sun text-base text-[#2a2036]">
                    {i + 1}
                  </span>
                  <h3 className="mt-3 text-lg">{title}</h3>
                  <p className="mt-2 text-sm text-muted">{body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Meet Zeb */}
        <section id="zeb" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16">
          <SectionTitle
            eyebrow="Meet Zeb"
            title="A treasury pet that reacts to your books"
            blurb="Zeb's mood comes from your real finances: balances, approvals, pay days and payments."
          />
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {moods.map(([mood, label, why]) => (
              <div key={mood} className="card flex flex-col items-center p-3 text-center">
                <div className="screen flex w-full justify-center px-2 pb-1 pt-3">
                  <Pet mood={mood} size={64} />
                </div>
                <p className="display mt-2 text-sm">{label}</p>
                <p className="text-xs text-muted">{why}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Call to action */}
        <section className="mx-auto max-w-6xl px-4">
          <div className="card flex flex-col items-center gap-5 p-8 text-center sm:flex-row sm:text-left" style={{ background: "var(--accent-soft)" }}>
            <div className="screen shrink-0 px-4 pb-1 pt-4">
              <Pet mood="egg" size={72} />
            </div>
            <div className="flex-1">
              <h2 className="text-2xl sm:text-3xl">Ready to hatch your workspace?</h2>
              <p className="mt-1 text-muted">Takes a minute: pick personal or team, create a passkey, save your recovery kit. Everything runs on Zcash testnet.</p>
            </div>
            <div className="flex flex-wrap justify-center gap-3">
              <Link href="/signup" className="btn px-6 py-3 text-base">
                Get started
              </Link>
              <Link href="/login" className="btn-ghost px-6 py-3 text-base">
                Sign in
              </Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function SectionTitle({ eyebrow, title, blurb }: { eyebrow: string; title: string; blurb?: string }) {
  return (
    <div className="max-w-2xl">
      <p className="label text-accent-ink">{eyebrow}</p>
      <h2 className="text-3xl sm:text-4xl">{title}</h2>
      {blurb && <p className="mt-2 text-muted">{blurb}</p>}
    </div>
  );
}
