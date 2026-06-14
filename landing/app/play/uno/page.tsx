"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, colorName } from "@/components/uno/Card";
import { UnoClient, type GameView } from "@/lib/uno/uno-client";
import { type UnoCard, type TopState, isWildCard } from "@/lib/uno/uno-rules";
import { hasInjectedWallet } from "@/lib/wallet";
import { useWallet } from "@/components/wallet/WalletProvider";
import { linkifyTx } from "@/components/linkifyTx";
import { POT_ADDRESS, addresses as unoAddresses } from "@/lib/uno/deployment";

const UNO_MANAGER = unoAddresses.delegationManager;

// Same-origin by default: the game backend now runs inside this Next.js app
// (app/api/*), so fetch("/api/state") hits it directly. Override only for a
// standalone server via NEXT_PUBLIC_UNO_BACKEND_URL.
const BACKEND_URL = process.env.NEXT_PUBLIC_UNO_BACKEND_URL ?? "";

type Phase = "connect" | "waiting" | "lobby" | "paying" | "playing" | "done";

function short(a?: string | null) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

export default function Home() {
  // Shared, app-wide wallet (one connector for the whole site — see WalletProvider).
  const wallet = useWallet();
  const conn = wallet.connection;
  const account = conn?.account ?? null;
  const grant = wallet.grant;
  const copied = wallet.copied;
  const [phase, setPhase] = useState<Phase>("connect");
  const [starting, setStarting] = useState(false);
  const [view, setView] = useState<GameView | null>(null);
  const [hand, setHand] = useState<UnoCard[]>([]);
  const [legal, setLegal] = useState<number[]>([]);
  const [paymentTx, setPaymentTx] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wildPick, setWildPick] = useState<{ index: number; card: UnoCard } | null>(null);

  const clientRef = useRef<UnoClient | null>(null);
  const paidRef = useRef(false);
  const grantStoredRef = useRef(false);
  const [awaitingAdvance, setAwaitingAdvance] = useState(false);

  const addLog = useCallback((m: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 40));
  }, []);

  const client = useMemo(() => {
    if (!account) return null;
    const c = new UnoClient(BACKEND_URL, account);
    clientRef.current = c;
    return c;
  }, [account]);

  // When connected, advance to the lobby; once an ERC-7715 grant exists, store it
  // with the UNO backend (redeemed at buy-in via the canonical DelegationManager).
  useEffect(() => {
    if (account && (phase === "connect")) setPhase("waiting");
  }, [account, phase]);
  useEffect(() => {
    if (!account || !grant || grantStoredRef.current) return;
    grantStoredRef.current = true;
    void new UnoClient(BACKEND_URL, account)
      .grantSpend(grant)
      .then((r) => addLog(r.ok ? `spend permission stored — up to ${grant.capUsd} USDC/day` : `grant store failed: ${r.error}`))
      .catch((e) => addLog(`grant store failed: ${e instanceof Error ? e.message : String(e)}`));
  }, [account, grant, addLog]);

  const connectWith = useCallback(
    async (mode: "metamask" | "guest") => {
      const c = await wallet.connect(mode);
      if (c) addLog(`connected ${c.kind === "metamask" ? "MetaMask Smart Account" : "guest wallet"} ${short(c.account.address)}`);
      if (wallet.error) setError(wallet.error);
    },
    [wallet, addLog],
  );
  const connect = useCallback(() => {
    void connectWith(hasInjectedWallet() ? "metamask" : "guest");
  }, [connectWith]);

  const disconnect = useCallback(() => {
    wallet.disconnect();
    setView(null);
    setPhase("connect");
    paidRef.current = false;
    grantStoredRef.current = false;
    setPaymentTx(null);
    setHand([]);
    setLegal([]);
    addLog("disconnected");
  }, [wallet, addLog]);

  const copyAddr = wallet.copyAddress;

  // Start a fresh game seated with THIS wallet (used when the connected address
  // isn't already seated in the auto-started demo game).
  const startGame = useCallback(async () => {
    if (!client || starting) return;
    setStarting(true);
    setError(null);
    try {
      addLog("starting a game with your wallet…");
      const res = await client.start();
      if (!res.ok) throw new Error(res.error ?? "could not start a game");
      addLog(`game ${res.roomId ?? ""} started — you're seated`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [client, starting, addLog]);

  const board: TopState = view ? view.board : { topColor: 1, topValue: 5, activeColor: 1 };

  const turnIsMine = Boolean(
    account && view?.currentTurn && view.currentTurn.toLowerCase() === account.address.toLowerCase(),
  );
  const myTurn = turnIsMine && !awaitingAdvance;

  useEffect(() => {
    if (!turnIsMine && awaitingAdvance) setAwaitingAdvance(false);
  }, [turnIsMine, awaitingAdvance]);
  useEffect(() => {
    if (!awaitingAdvance) return;
    const id = setTimeout(() => setAwaitingAdvance(false), 3500);
    return () => clearTimeout(id);
  }, [awaitingAdvance]);

  // Poll the public state.
  useEffect(() => {
    if (!client || phase === "connect") return;
    let alive = true;
    const tick = async () => {
      try {
        const st = await client.state();
        if (!alive || !st.ok) return;
        setView(st);
        const seat = account && st.seats.find((s) => s.address.toLowerCase() === account.address.toLowerCase());
        if (seat) {
          setPhase((p) => {
            if (st.winner) return "done";
            if (p === "waiting") return "lobby";
            if (p === "lobby" && seat.paid) return "playing";
            return p;
          });
        }
      } catch {
        /* transient */
      }
    };
    void tick();
    const id = setInterval(tick, 1800);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client, phase, account]);

  // Refresh our private (sealed) hand whenever the board changes or our turn comes.
  useEffect(() => {
    if (!client || (phase !== "playing" && phase !== "done")) return;
    let alive = true;
    (async () => {
      const r = await client.hand().catch(() => null);
      if (!alive || !r || !r.ok) return;
      setHand(r.hand);
      setLegal(r.legal);
    })();
    return () => {
      alive = false;
    };
  }, [client, phase, view?.board?.topColor, view?.board?.topValue, view?.board?.activeColor, view?.currentTurn]);

  useEffect(() => {
    if (view?.winner) setPhase("done");
  }, [view?.winner]);

  const pay = useCallback(async () => {
    if (!client || !view || paidRef.current) return;
    paidRef.current = true;
    setBusy(true);
    setError(null);
    setPhase("paying");
    try {
      // MetaMask rail with an ERC-7715 grant: the spend is already authorized by
      // MetaMask's native popup, redeemed via the canonical DelegationManager — no
      // budget delegation, no `approve`, no second signature.
      const useGrant = conn?.kind === "metamask" && grant !== null;
      let res: { ok: boolean; txHash?: string; error?: string };
      if (useGrant) {
        addLog(`paying ${view.fee} USDC entry fee via your MetaMask spend permission (x402)…`);
        res = await client.payViaGrant();
      } else {
        // GUEST rail: bring your own USDC — approve the delegation manager, then
        // sign + redeem our custom budget delegation (unchanged; keeps the e2e working).
        const feeWei = BigInt(Math.round(Number(view.fee) * 1e6));
        if (conn) {
          addLog("checking USDC allowance (approve if needed)…");
          await conn.ensureApproval(UNO_MANAGER, feeWei);
        }
        addLog(`signing budget delegation + paying ${view.fee} USDC entry fee (x402)…`);
        res = await client.pay(POT_ADDRESS, view.fee);
      }
      if (!res.ok || !res.txHash) throw new Error(res.error ?? "charge failed");
      setPaymentTx(res.txHash);
      addLog(`PAID — real USDC transfer settled, tx ${res.txHash}`);
      setPhase("playing");
    } catch (e) {
      paidRef.current = false;
      setError(e instanceof Error ? e.message : String(e));
      addLog(`payment error: ${e instanceof Error ? e.message : String(e)}`);
      setPhase("lobby");
    } finally {
      setBusy(false);
    }
  }, [client, view, conn, grant, addLog]);

  const submitPlay = useCallback(
    async (card: UnoCard, chosenColor: number) => {
      if (!client || !view) return;
      setBusy(true);
      setError(null);
      try {
        const label = isWildCard(card) ? `wild → ${colorName(chosenColor)}` : `${colorName(card.color)} ${card.value <= 9 ? card.value : "action"}`;
        addLog(`playing ${label} (gasless move)…`);
        const res = await client.move(view.roomId, "play", card, chosenColor);
        if (!res.ok || !res.txHash) throw new Error(res.error ?? "move rejected");
        addLog(`move landed — tx ${res.txHash}`);
        setAwaitingAdvance(true);
        const r = await client.hand().catch(() => null);
        if (r?.ok) {
          setHand(r.hand);
          setLegal(r.legal);
        }
        if (res.winner) {
          addLog(`WINNER ${short(res.winner)} — pot payout tx ${res.payoutTx}`);
          setPhase("done");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        addLog(`move error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [client, view, addLog],
  );

  const onCardClick = useCallback(
    (idx: number) => {
      const c = hand[idx];
      if (!c || !legal.includes(idx)) return;
      if (isWildCard(c)) {
        setWildPick({ index: idx, card: c }); // open color picker
        return;
      }
      void submitPlay(c, c.color);
    },
    [hand, legal, submitPlay],
  );

  const drawCard = useCallback(async () => {
    if (!client || !view) return;
    setBusy(true);
    try {
      addLog("drawing a card (gasless move)…");
      const res = await client.move(view.roomId, "draw");
      if (!res.ok || !res.txHash) throw new Error(res.error ?? "draw rejected");
      addLog(`drew — ${res.playable ? "playable, your turn continues" : "passed"} — tx ${res.txHash}`);
      if (!res.playable) setAwaitingAdvance(true);
      const r = await client.hand().catch(() => null);
      if (r?.ok) {
        setHand(r.hand);
        setLegal(r.legal);
      }
    } catch (e) {
      addLog(`draw error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [client, view, addLog]);

  // Auto-play: pick the first legal card (choosing the most-held color for wilds).
  const autoPlay = useCallback(async () => {
    if (!myTurn || busy || phase !== "playing") return;
    if (legal.length === 0) {
      await drawCard();
      return;
    }
    const idx = legal[0];
    const c = hand[idx];
    if (isWildCard(c)) {
      const counts = [0, 0, 0, 0, 0];
      for (const h of hand) if (!isWildCard(h) && h.color >= 1 && h.color <= 4) counts[h.color]++;
      let best = 1;
      for (let k = 2; k <= 4; k++) if (counts[k] > counts[best]) best = k;
      await submitPlay(c, best);
    } else {
      await submitPlay(c, c.color);
    }
  }, [myTurn, busy, phase, legal, hand, drawCard, submitPlay]);

  const topCard: UnoCard = { color: board.topColor, value: board.topValue };

  return (
    <main className="relative mx-auto min-h-screen max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-end justify-between">
        <div>
          <h1 className="font-display text-4xl font-extrabold tracking-tight text-ink">
            <span className="text-coral">UNO</span>{" "}
            <span className="text-ink-soft text-2xl font-bold">by Nexus</span>
          </h1>
          <p className="mt-1 text-sm font-medium text-ink-faint">
            Full official ruleset · 108-card deck · gasless moves · x402 entry · sealed hands · on-chain shuffle · Base Sepolia
          </p>
        </div>
        {account ? (
          <div className="flex items-center gap-2">
            <span
              className="rounded-full border-[2px] border-ink bg-paper-deep px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-soft"
            >
              {conn?.kind === "metamask" ? "Smart Account" : "Guest"}
            </span>
            <button
              type="button"
              onClick={copyAddr}
              data-testid="wallet-address"
              title="Copy address"
              className="sticker sticker-lift sticker-press flex items-center gap-1.5 rounded-full bg-paper px-3 py-1.5 text-xs font-medium text-ink-soft transition"
            >
              <span className="font-mono">{short(account.address)}</span>
              <span className="text-ink-faint">{copied ? "✓" : "⧉"}</span>
            </button>
            <button
              type="button"
              onClick={disconnect}
              data-testid="disconnect"
              title="Disconnect"
              className="sticker sticker-lift sticker-press rounded-full bg-paper px-3 py-1.5 text-xs font-bold text-ink-soft transition hover:text-coral"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="text-right text-xs font-mono text-ink-faint">not connected</div>
        )}
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <section className="sticker rounded-chunk bg-paper p-8">
          {phase === "connect" && (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-6 text-center">
              <span className="grid h-20 w-20 place-items-center rounded-2xl border-[2.5px] border-ink bg-coral font-display text-4xl font-extrabold text-paper shadow-sticker">
                UN
              </span>
              <h2 className="font-display text-2xl font-extrabold text-ink">Sit down at the table</h2>
              <p className="max-w-md text-[15px] leading-relaxed text-ink-soft">
                Connect <b>MetaMask</b> to join a real game of UNO against the bots — you sign one
                delegation, then every move is gasless. Bring a little Base-Sepolia USDC for the entry fee.
              </p>
              <button
                type="button"
                data-testid="connect"
                onClick={connect}
                className="sticker sticker-lift sticker-press flex items-center gap-2 rounded-full bg-coral px-8 py-3 font-bold text-paper transition"
              >
                Connect MetaMask
              </button>
              <button
                type="button"
                data-testid="connect-guest"
                onClick={() => void connectWith("guest")}
                className="text-xs font-semibold text-ink-faint underline underline-offset-2 hover:text-ink-soft"
              >
                No wallet? Use a temporary guest wallet
              </button>
            </div>
          )}

          {phase === "waiting" && (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-5 text-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-coral border-t-transparent" />
              <p className="font-semibold text-ink-soft" data-testid="waiting">
                Looking for your seat at the table…
              </p>
              <p className="max-w-sm text-xs text-ink-faint">
                If no game is waiting for your wallet, start a fresh one — you&apos;ll be seated against the bots.
              </p>
              <button
                type="button"
                data-testid="start-game"
                onClick={() => void startGame()}
                disabled={starting}
                className="sticker sticker-lift sticker-press rounded-full bg-coral px-8 py-3 font-bold text-paper transition disabled:opacity-50"
              >
                {starting ? "Starting…" : "Start a game"}
              </button>
            </div>
          )}

          {phase === "lobby" && (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-6 text-center">
              <h2 className="font-display text-2xl font-extrabold text-ink">Buy in to the pot</h2>
              <p className="max-w-md text-[15px] leading-relaxed text-ink-soft">
                The entry fee is <b>{view?.fee ?? "1"} USDC</b>, paid as a real x402 charge from <b>your</b> wallet to the
                Pot at {short(POT_ADDRESS)} —{" "}
                {grant
                  ? <>bounded by your MetaMask spend permission (<b>{grant.capUsd} USDC/day</b>), redeemed via the canonical DelegationManager.</>
                  : <>bounded on-chain by your budget delegation.</>}
              </p>
              <button
                type="button"
                data-testid="join-and-pay"
                onClick={pay}
                disabled={busy}
                className="sticker sticker-lift sticker-press rounded-full bg-coral px-8 py-3 font-bold text-paper transition disabled:opacity-50"
              >
                {busy ? "Working…" : `Pay ${view?.fee ?? "1"} USDC`}
              </button>
            </div>
          )}

          {phase === "paying" && (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-4 text-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-coral border-t-transparent" />
              <p className="font-semibold text-ink-soft">Settling your {view?.fee ?? "1"} USDC entry fee on Base Sepolia…</p>
            </div>
          )}

          {(phase === "playing" || phase === "done") && (
            <div className="flex min-h-[420px] flex-col">
              <div className="mb-10 flex items-center justify-center gap-10">
                <div className="flex flex-col items-center gap-2">
                  <div className="text-xs font-bold uppercase tracking-widest text-ink-faint">discard</div>
                  <div data-testid="discard-top">
                    <Card card={topCard} disabled />
                  </div>
                  <div className="font-mono text-xs text-ink-faint" data-testid="active-color">
                    active: {colorName(board.activeColor)} · {view?.direction === -1 ? "↺ ccw" : "↻ cw"}
                  </div>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className="text-xs font-bold uppercase tracking-widest text-ink-faint">draw pile</div>
                  <button
                    type="button"
                    data-testid="draw"
                    onClick={drawCard}
                    disabled={busy || !myTurn || phase === "done"}
                    className="sticker sticker-lift sticker-press flex h-36 w-24 items-center justify-center rounded-2xl bg-paper-deep font-display text-3xl font-black text-ink-soft transition disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="mt-auto">
                <div className="mb-3 flex items-center justify-between">
                  <span
                    data-testid="turn-indicator"
                    className={`text-xs font-bold uppercase tracking-widest rounded-full px-3 py-1 border-[2px] border-ink ${
                      myTurn ? "bg-coral text-paper shadow-sticker-sm" : "bg-paper-deep text-ink-faint"
                    }`}
                  >
                    {phase === "done" ? "game over" : myTurn ? "your turn" : "waiting for opponents…"}
                  </span>
                  <button
                    type="button"
                    data-testid="auto-play"
                    onClick={autoPlay}
                    disabled={!myTurn || busy || phase === "done"}
                    className="sticker sticker-lift sticker-press rounded-full bg-amber px-4 py-1 text-xs font-bold text-ink transition disabled:opacity-40"
                  >
                    auto-play
                  </button>
                  <span className="font-mono text-xs text-ink-faint">{hand.length} cards</span>
                </div>
                <div className="flex flex-wrap items-end gap-3" data-testid="hand">
                  {hand.map((c, i) => (
                    <Card
                      key={`${c.color}-${c.value}-${i}`}
                      card={c}
                      testid={`hand-card-${i}`}
                      disabled={busy || !myTurn || phase === "done" || !legal.includes(i)}
                      onClick={() => onCardClick(i)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-4">
          <div className="sticker rounded-chunk bg-paper p-5">
            <h3 className="mb-3 font-display text-sm font-extrabold uppercase tracking-wider text-coral">Payment</h3>
            {paymentTx ? (
              <div className="space-y-1">
                <div data-testid="payment-status" className="font-bold text-grass">
                  PAID · {view?.fee ?? "1"} USDC
                </div>
                <a
                  data-testid="payment-tx"
                  href={`https://sepolia.basescan.org/tx/${paymentTx}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono block break-all text-xs text-amber underline underline-offset-2"
                >
                  {paymentTx}
                </a>
              </div>
            ) : (
              <div className="text-sm text-ink-faint">No entry fee paid yet.</div>
            )}
          </div>

          <div className="sticker rounded-chunk bg-paper p-5">
            <h3 className="mb-3 font-display text-sm font-extrabold uppercase tracking-wider text-coral">Game</h3>
            <dl className="space-y-1 text-sm">
              <Row k="Room" v={view?.roomId ?? "—"} />
              <Row k="Seats" v={view ? String(view.seats.length) : "—"} />
              <Row k="Pot" v={short(POT_ADDRESS)} />
              <Row k="Top card" v={`${colorName(board.topColor)} ${board.topValue <= 9 ? board.topValue : "action"}`} />
              <Row k="Turn" v={short(view?.currentTurn)} />
              <Row k="Winner" v={short(view?.winner)} />
            </dl>
            {view?.shuffleTx && (
              <a
                href={`https://sepolia.basescan.org/tx/${view.shuffleTx}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono mt-2 block break-all text-[10px] text-ink-faint underline underline-offset-2"
              >
                on-chain shuffle {short(view.shuffleTx)}
              </a>
            )}
            {view?.winner && (
              <div data-testid="winner-banner" className="mt-3 rounded-xl border-[2px] border-grass bg-grass/10 p-3 text-center text-sm font-bold text-grass">
                WINNER {short(view.winner)}
                {view.payoutTx && (
                  <a
                    data-testid="payout-tx"
                    href={`https://sepolia.basescan.org/tx/${view.payoutTx}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono mt-1 block break-all text-[10px] font-normal text-amber underline underline-offset-2"
                  >
                    payout {view.payoutTx}
                  </a>
                )}
              </div>
            )}
          </div>

          <div className="sticker flex-1 rounded-chunk bg-paper p-5">
            <h3 className="mb-3 font-display text-sm font-extrabold uppercase tracking-wider text-coral">Activity</h3>
            <div className="font-mono max-h-72 space-y-1 overflow-auto text-[11px] leading-relaxed text-ink-soft">
              {log.length === 0 ? <div className="text-ink-faint">—</div> : log.map((l, i) => <div key={i} className="break-all">{linkifyTx(l)}</div>)}
            </div>
          </div>

          {error && (
            <div className="sticker rounded-chunk border-coral/60 bg-coral/10 p-4 text-xs font-semibold text-coral-deep" data-testid="error">
              {error}
            </div>
          )}
        </aside>
      </div>

      {/* Wild color picker */}
      {wildPick && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 backdrop-blur-sm">
          <div className="sticker rounded-chunk bg-paper p-8 text-center shadow-sticker-lg">
            <h3 className="mb-5 font-display text-lg font-extrabold text-ink">Pick a color for your wild</h3>
            <div className="flex gap-4">
              {[1, 2, 3, 4].map((col) => (
                <button
                  key={col}
                  type="button"
                  data-testid={`wild-color-${col}`}
                  onClick={() => {
                    const p = wildPick;
                    setWildPick(null);
                    void submitPlay(p.card, col);
                  }}
                  className="h-16 w-16 rounded-2xl border-[2.5px] border-ink shadow-sticker-sm transition hover:scale-110 hover:-translate-y-1"
                  style={{ background: ["", "#e4002b", "#3aa935", "#0073cf", "#ffcc00"][col] }}
                  aria-label={colorName(col)}
                />
              ))}
            </div>
            <button type="button" onClick={() => setWildPick(null)} className="mt-5 text-xs font-semibold text-ink-faint underline underline-offset-2 hover:text-ink-soft">
              cancel
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-ink-faint">{k}</dt>
      <dd className="font-mono text-ink-soft">{v}</dd>
    </div>
  );
}
