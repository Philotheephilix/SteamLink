"use client";

import { useState } from "react";
import { DocsShell, type DocTab } from "@/components/docs/DocsShell";
import { SdkDocs, SDK_NAV } from "@/components/docs/SdkDocs";
import { ContributeDocs, CONTRIBUTE_NAV } from "@/components/docs/ContributeDocs";

const TABS: DocTab[] = [
  { key: "sdk", label: "SDK reference", sub: "Use the @steamlink/* packages" },
  { key: "contribute", label: "Contribute a game", sub: "Raise a PR to add UNO/Monopoly-style games" },
];

export default function DocsPage() {
  const [tab, setTab] = useState<string>("sdk");

  function switchTab(key: string) {
    setTab(key);
    window.scrollTo({ top: 0 });
  }

  const nav = tab === "sdk" ? SDK_NAV : CONTRIBUTE_NAV;

  return (
    <DocsShell tabs={TABS} activeTab={tab} onTab={switchTab} nav={nav}>
      {tab === "sdk" ? <SdkDocs /> : <ContributeDocs />}
    </DocsShell>
  );
}
