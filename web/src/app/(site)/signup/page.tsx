"use client";

import { PetIntro } from "@/components/PetIntro";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { put } from "@/lib/api";
import { signup } from "@/lib/flows";
import { PRESETS, type Preset } from "@/lib/policy-presets";
import { saveRecord } from "@/lib/records";
import { useSession } from "@/lib/session";
import type { WorkspaceMode } from "@/lib/workspace";

export default function SignupPage() {
  const router = useRouter();
  const { setSession } = useSession();
  const [orgName, setOrgName] = useState("");
  const [yourName, setYourName] = useState("");
  const [kind, setKind] = useState<WorkspaceMode>("personal");
  const [setup, setSetup] = useState<Preset>("solo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // A personal workspace is named after its owner.
      const name = kind === "personal" ? yourName.trim() : orgName.trim();
      const { session, recoveryPhrase } = await signup(name, yourName.trim());
      // The server starts every workspace on the team policy; personal ones and
      // solo founders apply theirs right away (as the only admin, no second
      // confirmation is needed).
      if (kind === "personal" || setup === "solo") await put("/v1/policy", PRESETS.solo.policy, session.token);
      await saveRecord(session, { type: "workspace", mode: kind });
      setSession(session);
      setPhrase(recoveryPhrase);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (phrase) {
    const words = phrase.split(" ");
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-12">
        <PetIntro mood="party" eyebrow="It hatched!" title="Meet Zeb. Now save your recovery kit." home={false}>
          These 24 words are the only way back into your organization if every admin loses their passkey. We
          can&apos;t reset your access: your data is encrypted with keys we never see. Write them down or store
          them in a password manager, and keep them offline.
        </PetIntro>
        <ol className="card mt-6 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
          {words.map((w, i) => (
            <li key={i} className="flex gap-2 rounded-lg border-2 border-dashed border-border/30 px-2 py-1 font-mono text-sm">
              <span className="w-6 text-right text-muted">{i + 1}.</span>
              <span>{w}</span>
            </li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="btn-ghost" onClick={() => navigator.clipboard.writeText(phrase)}>
            Copy words
          </button>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I&apos;ve stored my recovery kit somewhere safe
          </label>
        </div>
        <p className="mt-4 text-xs text-muted">
          Losing all passkeys <em>and</em> this kit means losing access to your organization&apos;s data.
          Add a second admin soon so there are always two ways in.
        </p>
        <button
          className="btn mt-6"
          disabled={!saved}
          onClick={() => {
            setPhrase(null);
            router.push("/app");
          }}
        >
          Open dashboard
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-md px-4 py-16">
      <PetIntro mood="egg" eyebrow="Get started" title="Create your workspace">
          You&apos;ll create a passkey on this device. It signs you in and unlocks your workspace&apos;s encryption
          key, which is generated here in your browser and never sent to us unencrypted.
      </PetIntro>
      <form onSubmit={onSubmit} className="card mt-6 space-y-4">
        <fieldset>
          <legend className="label">What&apos;s this for?</legend>
          <div className="grid gap-2">
            <Choice
              name="kind"
              checked={kind === "personal"}
              onChange={() => setKind("personal")}
              title="🧑 Personal"
              blurb="Just you: pay the people who work for you, invoice, hold TAZ privately and run sealed-bid auctions."
            />
            <Choice
              name="kind"
              checked={kind === "team"}
              onChange={() => setKind("team")}
              title="🏢 Company or team"
              blurb="Everything in personal, plus teammates with shared approvals, and kudos."
            />
          </div>
        </fieldset>
        {kind === "team" && (
          <div>
            <label className="label" htmlFor="org">
              Organization name
            </label>
            <input
              id="org"
              className="input"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Acme Labs"
              required
              maxLength={80}
            />
            <p className="mt-1 text-xs text-muted">Encrypted before it leaves your browser.</p>
          </div>
        )}
        <div>
          <label className="label" htmlFor="you">
            Your name
          </label>
          <input
            id="you"
            className="input"
            value={yourName}
            onChange={(e) => setYourName(e.target.value)}
            placeholder="Alex"
            required
            maxLength={80}
          />
          {kind === "personal" && <p className="mt-1 text-xs text-muted">Encrypted before it leaves your browser.</p>}
        </div>
        {kind === "team" && (
          <fieldset>
            <legend className="label">Who approves payments?</legend>
            <div className="grid gap-2">
              {(Object.keys(PRESETS) as Preset[]).map((k) => (
                <Choice
                  key={k}
                  name="setup"
                  checked={setup === k}
                  onChange={() => setSetup(k)}
                  title={`${k === "solo" ? "🧑" : "👥"} ${k === "solo" ? "Just me (founder)" : PRESETS[k].label}`}
                  blurb={PRESETS[k].blurb}
                />
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">You can switch any time in Spending policy as your team grows.</p>
          </fieldset>
        )}
        <button className="btn w-full" disabled={busy || (kind === "team" && !orgName.trim()) || !yourName.trim()}>
          {busy ? "Waiting for passkey…" : "Create passkey and workspace"}
        </button>
        {error && <p className="text-sm text-danger">{error}</p>}
      </form>
    </main>
  );
}

function Choice({ name, checked, onChange, title, blurb }: { name: string; checked: boolean; onChange: () => void; title: string; blurb: string }) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-xl border-[3px] p-3 text-sm ${
        checked ? "border-accent-strong bg-accent-soft" : "border-border/30"
      }`}
    >
      <input type="radio" name={name} className="mt-1" checked={checked} onChange={onChange} />
      <span>
        <span className="display block">{title}</span>
        <span className="text-xs text-muted">{blurb}</span>
      </span>
    </label>
  );
}
