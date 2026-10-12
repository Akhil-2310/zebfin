import Link from "next/link";
import { Pet } from "@/components/Pet";
import type { Mood } from "@/lib/pet";

/** Page opener for auth and portal pages: Zeb on its little screen, saying the intro. */
export function PetIntro({
  mood,
  eyebrow,
  title,
  children,
  home = false,
}: {
  mood: Mood;
  eyebrow?: string;
  title: React.ReactNode;
  children?: React.ReactNode;
  home?: boolean;
}) {
  return (
    <div className="print:hidden">
      {home && (
        <Link href="/" className="pixel inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
          ← ZEBFIN
        </Link>
      )}
      <div className="mt-4 flex items-start gap-4">
        <div className="screen shrink-0 px-2 pb-1 pt-2 sm:px-3 sm:pt-3">
          <span className="hidden sm:block">
            <Pet mood={mood} size={72} />
          </span>
          <span className="sm:hidden">
            <Pet mood={mood} size={48} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <span className="chip chip-sun">
              {eyebrow}
            </span>
          )}
          <h1 className="mt-2 text-2xl sm:text-3xl">{title}</h1>
          {children && <div className="bubble bubble-left mt-3 text-muted">{children}</div>}
        </div>
      </div>
    </div>
  );
}
