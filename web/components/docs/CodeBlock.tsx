"use client";

import { useState } from "react";

/**
 * A documentation code block on the paper/sticker theme: an ink-dark "terminal"
 * card with a sticker border, an optional filename/lang tab, and a copy button
 * that flips to a check for ~1.2s. `lang="bash"` renders a leading `$` prompt
 * glyph per line and copies the command without it.
 */
export function CodeBlock({
  code,
  lang = "ts",
  title,
}: {
  code: string;
  lang?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = code.replace(/\n+$/, "");

  async function copy() {
    // For shell snippets, strip the visual prompt so the user copies a runnable line.
    const payload = lang === "bash" ? text.replace(/^\$ /gm, "") : text;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  const label = title ?? langLabel(lang);

  return (
    <div className="group relative my-5 overflow-hidden rounded-chunk border-[2.5px] border-ink bg-[oklch(0.21_0.028_55)] shadow-sticker">
      <div className="flex items-center justify-between border-b-[2.5px] border-ink/40 px-4 py-2">
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full bg-coral" aria-hidden />
          <span className="h-3 w-3 rounded-full bg-amber" aria-hidden />
          <span className="h-3 w-3 rounded-full bg-grass" aria-hidden />
          {label && (
            <span className="ml-2.5 font-mono text-xs font-semibold tracking-wide text-paper/55">
              {label}
            </span>
          )}
        </div>
        <button
          onClick={copy}
          aria-label="Copy code"
          className="sticker-press flex items-center gap-1.5 rounded-full border-2 border-paper/20 bg-paper/5 px-3 py-1 text-xs font-bold text-paper/80 transition-colors hover:border-paper/40 hover:bg-paper/10 hover:text-paper"
        >
          {copied ? (
            <>
              <CheckIcon /> Copied
            </>
          ) : (
            <>
              <CopyIcon /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 text-[13px] leading-relaxed">
        <code className="font-mono text-paper/90">
          {lang === "bash"
            ? text.split("\n").map((line, i) => (
                <span key={i} className="block">
                  {line.startsWith("$ ") ? (
                    <>
                      <span className="select-none text-grass/80">$ </span>
                      {line.slice(2)}
                    </>
                  ) : (
                    <span className={line.startsWith("#") ? "text-paper/45" : ""}>{line}</span>
                  )}
                </span>
              ))
            : text}
        </code>
      </pre>
    </div>
  );
}

function langLabel(lang: string): string {
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    sol: "solidity",
    bash: "shell",
    json: "json",
  };
  return map[lang] ?? lang;
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="2.2" />
      <path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 12.5l5 5L20 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
