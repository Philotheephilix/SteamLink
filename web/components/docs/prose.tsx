import type { ReactNode } from "react";

/** A scroll-spy anchor section. `id` must match a sidebar nav item id. */
export function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 pt-10 first:pt-2">
      {children}
    </section>
  );
}

export function PageTitle({ children, kicker }: { children: ReactNode; kicker?: string }) {
  return (
    <div className="mb-2">
      {kicker && (
        <div className="mb-2 text-sm font-extrabold uppercase tracking-wider text-coral">{kicker}</div>
      )}
      <h1 className="font-display text-4xl font-extrabold tracking-tight sm:text-5xl">{children}</h1>
    </div>
  );
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-3 mt-2 font-display text-2xl font-extrabold tracking-tight sm:text-3xl">
      {children}
    </h2>
  );
}

export function H3({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-7 font-display text-lg font-extrabold tracking-tight">{children}</h3>;
}

export function P({ children }: { children: ReactNode }) {
  return <p className="my-3 max-w-2xl text-[15px] leading-7 text-ink-soft">{children}</p>;
}

export function Lead({ children }: { children: ReactNode }) {
  return <p className="my-4 max-w-2xl text-lg leading-8 font-medium text-ink">{children}</p>;
}

/** Inline `code` token. */
export function C({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md border-2 border-ink/15 bg-paper-deep px-1.5 py-0.5 font-mono text-[0.85em] font-semibold text-coral-deep">
      {children}
    </code>
  );
}

const TONES = {
  note: { bg: "bg-sky/12", border: "border-sky", dot: "bg-sky", label: "Note" },
  tip: { bg: "bg-grass/12", border: "border-grass", dot: "bg-grass", label: "Tip" },
  warn: { bg: "bg-amber/15", border: "border-amber", dot: "bg-amber", label: "Heads up" },
  rule: { bg: "bg-coral/10", border: "border-coral", dot: "bg-coral", label: "Invariant" },
} as const;

export function Callout({
  tone = "note",
  title,
  children,
}: {
  tone?: keyof typeof TONES;
  title?: string;
  children: ReactNode;
}) {
  const t = TONES[tone];
  return (
    <div className={`my-5 rounded-chunk border-[2.5px] ${t.border} ${t.bg} p-4`}>
      <div className="mb-1 flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${t.dot}`} aria-hidden />
        <span className="text-xs font-extrabold uppercase tracking-wide text-ink">
          {title ?? t.label}
        </span>
      </div>
      <div className="text-[14px] leading-7 text-ink-soft [&_a]:font-bold [&_a]:text-coral-deep [&_a]:underline">
        {children}
      </div>
    </div>
  );
}

/** A card documenting a single method / export. */
export function Method({
  signature,
  pkg,
  children,
}: {
  signature: string;
  pkg?: string;
  children: ReactNode;
}) {
  return (
    <div className="my-5 rounded-chunk border-[2.5px] border-ink bg-paper shadow-sticker-sm">
      <div className="flex flex-wrap items-center gap-2 border-b-[2.5px] border-ink/15 px-4 py-2.5">
        <code className="font-mono text-[13px] font-bold text-ink">{signature}</code>
        {pkg && (
          <span className="ml-auto rounded-full bg-paper-deep px-2 py-0.5 font-mono text-[11px] font-semibold text-ink-faint">
            {pkg}
          </span>
        )}
      </div>
      <div className="px-4 py-3 text-[14px] leading-7 text-ink-soft">{children}</div>
    </div>
  );
}

/** Small labelled chip row (e.g. package list). */
export function Pills({ items }: { items: string[] }) {
  return (
    <div className="my-3 flex flex-wrap gap-2">
      {items.map((it) => (
        <span
          key={it}
          className="rounded-full border-2 border-ink bg-paper px-3 py-1 font-mono text-xs font-bold text-ink shadow-sticker-sm"
        >
          {it}
        </span>
      ))}
    </div>
  );
}

/** Numbered step header for the contribution walkthrough. */
export function Step({ n, title }: { n: number; title: string }) {
  return (
    <div className="mb-3 mt-2 flex items-center gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border-[2.5px] border-ink bg-grape text-paper shadow-sticker-sm font-display text-lg font-extrabold">
        {n}
      </span>
      <h2 className="font-display text-2xl font-extrabold tracking-tight">{title}</h2>
    </div>
  );
}

export function Ul({ children }: { children: ReactNode }) {
  return <ul className="my-3 ml-1 max-w-2xl space-y-1.5 text-[15px] leading-7 text-ink-soft">{children}</ul>;
}

export function Li({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-coral" aria-hidden />
      <span>{children}</span>
    </li>
  );
}
