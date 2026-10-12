// Zeb, the treasury pet: a 16x16 pixel creature drawn as SVG rects. An
// original character (striped body, little fin) in a handheld-toy style.

import type { Mood } from "@/lib/pet";

// Palette keys: k ink, w body, s stripe, f fin, p cheek, e egg shell, c egg spot.
const BODY = [
  "................",
  "......ff........",
  ".....fff........",
  "....kkkkkkkk....",
  "...kwsswwsswwk..",
  "..kwwsswwsswwwk.",
  "..kwwwwwwwwwwwk.",
  ".kwwwwwwwwwwwwwk",
  ".kwwwwwwwwwwwwwk",
  ".kwwwwwwwwwwwwwk",
  ".kwwwwwwwwwwwwwk",
  "..kwwwwwwwwwwwk.",
  "..kwsswwwwsswwk.",
  "...kkwwwwwwwkk..",
  "....kk.kk.kk....",
  "................",
];

const EGG = [
  "................",
  "......kkkk......",
  ".....keeeek.....",
  "....keecceek....",
  "...keeeccceek...",
  "...keeeeeeeek...",
  "..keeceeeeceek..",
  "..keecceeecceek.",
  "..keeeeeeeeeek..",
  "..keeeeccceeek..",
  "..keeeeeccceek..",
  "...keeeeeeeek...",
  "...keeeeeeeek...",
  "....kkeeeekk....",
  "......kkkk......",
  "................",
];

type Px = [number, number, string];

// Face overlays: [row, col, key].
const FACES: Record<Exclude<Mood, "egg" | "payday">, Px[]> = {
  happy: [
    [7, 5, "k"], [8, 5, "k"], [7, 10, "k"], [8, 10, "k"],
    [9, 3, "p"], [9, 12, "p"],
    [10, 6, "k"], [11, 7, "k"], [11, 8, "k"], [10, 9, "k"],
  ],
  party: [
    [7, 4, "k"], [6, 5, "k"], [7, 6, "k"], [7, 9, "k"], [6, 10, "k"], [7, 11, "k"],
    [9, 3, "p"], [9, 12, "p"],
    [10, 6, "k"], [10, 9, "k"], [11, 6, "k"], [11, 7, "k"], [11, 8, "k"], [11, 9, "k"],
  ],
  content: [
    [7, 5, "k"], [8, 5, "k"], [7, 10, "k"], [8, 10, "k"],
    [9, 3, "p"], [9, 12, "p"],
    [10, 7, "k"], [10, 8, "k"],
  ],
  hungry: [
    [7, 5, "k"], [8, 5, "k"], [7, 10, "k"], [8, 10, "k"],
    [10, 7, "k"], [10, 8, "k"], [11, 7, "k"], [11, 8, "k"], [11, 9, "s"],
  ],
  busy: [
    [6, 4, "k"], [6, 5, "k"], [6, 10, "k"], [6, 11, "k"],
    [8, 5, "k"], [8, 10, "k"],
    [10, 6, "k"], [10, 7, "k"], [10, 8, "k"], [10, 9, "k"],
    [5, 13, "f"], [6, 13, "f"],
  ],
  sick: [
    [7, 4, "k"], [8, 5, "k"], [7, 6, "k"], [9, 4, "k"], [9, 6, "k"],
    [7, 9, "k"], [8, 10, "k"], [7, 11, "k"], [9, 9, "k"], [9, 11, "k"],
    [11, 6, "k"], [10, 7, "k"], [11, 8, "k"], [10, 9, "k"],
  ],
  sleepy: [
    [8, 4, "k"], [8, 5, "k"], [8, 6, "k"], [8, 9, "k"], [8, 10, "k"], [8, 11, "k"],
    [9, 3, "p"], [9, 12, "p"],
    [10, 7, "k"], [10, 8, "k"],
  ],
};

const COLORS: Record<string, string> = {
  k: "var(--ink)",
  w: "#fffaf0",
  s: "#6b5a7d",
  f: "var(--mint)",
  p: "var(--accent)",
  e: "#fff6e6",
  c: "var(--sun)",
};

const ANIM: Record<Mood, string> = {
  egg: "pet-wiggle",
  hungry: "pet-wiggle",
  sick: "",
  busy: "pet-bob",
  happy: "pet-bob",
  content: "pet-bob",
  sleepy: "",
  party: "pet-hop",
  payday: "pet-hop",
};

export function Pet({ mood, size = 96, className = "" }: { mood: Mood; size?: number; className?: string }) {
  const grid = mood === "egg" ? EGG : BODY;
  const pixels: Px[] = [];
  grid.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      if (ch !== ".") pixels.push([r, c, ch]);
    }),
  );
  const face = mood === "egg" ? [] : FACES[mood === "payday" ? "happy" : mood];
  // Sick tints the body; sleepy and party add props around the pet.
  const bodyColor = mood === "sick" ? "#e3f2c8" : COLORS.w;
  return (
    <span className={`relative inline-block ${className}`} style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 16 16" width={size} height={size} shapeRendering="crispEdges" className={ANIM[mood]}>
        {pixels.map(([r, c, ch]) => (
          <rect key={`${r}-${c}`} x={c} y={r} width={1} height={1} style={{ fill: ch === "w" ? bodyColor : COLORS[ch] }} />
        ))}
        {face.map(([r, c, ch]) => (
          <rect key={`f${r}-${c}`} x={c} y={r} width={1} height={1} style={{ fill: COLORS[ch] }} />
        ))}
      </svg>
      {mood === "sleepy" && <span className="pixel absolute -top-1 right-0 text-xs text-muted">z z</span>}
      {mood === "party" && <span className="absolute -top-2 -right-2 text-lg">🎉</span>}
      {mood === "payday" && <span className="absolute -top-2 -right-2 text-lg">💰</span>}
      {mood === "hungry" && <span className="absolute -top-1 -right-1 text-base">🍙</span>}
      {mood === "sick" && <span className="absolute -top-1 -right-1 text-base">🌡️</span>}
    </span>
  );
}
