"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Logo";

export type NavGroup = { group: string; items: { id: string; label: string }[] };
export type DocTab = { key: string; label: string; sub: string };

/**
 * The /docs chrome: a sticky paper header, the two top "divisions" as a
 * sticker tab switch, a sticky left sidebar that scroll-spies the active
 * section, and the content column. Switching tab resets scroll + active id.
 */
export function DocsShell({
  tabs,
  activeTab,
  onTab,
  nav,
  children,
}: {
  tabs: DocTab[];
  activeTab: string;
  onTab: (key: string) => void;
  nav: NavGroup[];
  children: React.ReactNode;
}) {
  const [active, setActive] = useState<string>(nav[0]?.items[0]?.id ?? "");
  const contentRef = useRef<HTMLDivElement>(null);

  // Scroll-spy: the topmost section whose heading is within the upper third
  // of the viewport is the active one.
  useEffect(() => {
    const ids = nav.flatMap((g) => g.items.map((i) => i.id));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-88px 0px -65% 0px", threshold: 0 },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [nav, activeTab]);

  function go(id: string) {
    const el = document.getElementById(id);
    if (el) {
      const y = el.getBoundingClientRect().top + window.scrollY - 84;
      window.scrollTo({ top: y, behavior: "smooth" });
      setActive(id);
    }
  }

  return (
    <div className="min-h-screen bg-paper font-body text-ink">
      {/* ── header ── */}
      <header className="sticky top-0 z-50 border-b-[2.5px] border-ink bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-5 py-3 sm:px-8">
          <Link href="/" className="shrink-0">
            <Logo wordClassName="hidden sm:inline" />
          </Link>
          <span className="hidden rounded-full border-[2.5px] border-ink bg-amber px-3 py-1 text-xs font-extrabold uppercase tracking-wide shadow-sticker-sm sm:inline">
            Docs
          </span>
          <Link
            href="/"
            className="sticker sticker-lift sticker-press shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-bold text-paper"
          >
            ← Home
          </Link>
        </div>

        {/* ── the two top divisions ── */}
        <div className="border-t-[2.5px] border-ink/15 bg-paper-deep/60">
          <div className="mx-auto flex max-w-7xl gap-2 px-5 py-2.5 sm:px-8">
            {tabs.map((tab) => {
              const on = tab.key === activeTab;
              return (
                <button
                  key={tab.key}
                  onClick={() => onTab(tab.key)}
                  className={`group flex-1 rounded-chunk border-[2.5px] border-ink px-4 py-2.5 text-left transition-all sm:flex-none sm:px-5 ${
                    on
                      ? "bg-coral text-paper shadow-sticker"
                      : "bg-paper text-ink shadow-sticker-sm hover:-translate-y-0.5"
                  }`}
                >
                  <div className="text-sm font-extrabold leading-tight sm:text-base">{tab.label}</div>
                  <div className={`text-xs font-medium ${on ? "text-paper/80" : "text-ink-soft"}`}>
                    {tab.sub}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-8 px-5 py-8 sm:px-8">
        {/* ── sidebar ── */}
        <aside className="sticky top-[148px] hidden h-[calc(100vh-168px)] w-60 shrink-0 overflow-y-auto pr-2 lg:block">
          <nav className="space-y-5">
            {nav.map((group) => (
              <div key={group.group}>
                <div className="mb-1.5 px-2 text-xs font-extrabold uppercase tracking-wider text-ink-faint">
                  {group.group}
                </div>
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const on = item.id === active;
                    return (
                      <li key={item.id}>
                        <button
                          onClick={() => go(item.id)}
                          className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm font-semibold transition-colors ${
                            on
                              ? "bg-ink text-paper"
                              : "text-ink-soft hover:bg-ink/5 hover:text-ink"
                          }`}
                        >
                          {item.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        {/* ── content ── */}
        <main ref={contentRef} className="min-w-0 flex-1 pb-24">
          {children}
        </main>
      </div>
    </div>
  );
}
