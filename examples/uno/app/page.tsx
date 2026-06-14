"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, colorName } from "../components/Card";
import { UnoClient, type GameView } from "../lib/uno-client";
import { type UnoCard, type TopState, isWildCard } from "../lib/uno-rules";
import { connectMetaMask, connectGuest, clearGuest, hasInjectedWallet, type Connection } from "../lib/signer";
import { POT_ADDRESS } from "../lib/deployment";

// Same-origin by default: the game backend now runs inside this Next.js app
// (app/api/*), so fetch("/api/state") hits it directly. Override only for a
// standalone server via NEXT_PUBLIC_UNO_BACKEND_URL.
const BACKEND_URL = process.env.NEXT_PUBLIC_UNO_BACKEND_URL ?? "";

type Phase = "connect" | "waiting" | "lobby" | "paying" | "playing" | "done";

function short(a?: string | null) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

export default function Home() {
  const [conn, setConn] = useState<Connection | null>(null);
  const account = conn?.account ?? null;
  const [phase, setPhase] = useState<Phase>("connect");
  const [copied, setCopied] = useState(false);
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

  const connectWith = useCallback(
    async (mode: "metamask" | "guest") => {
      setError(null);
      try {
        const c = mode === "metamask" ? await connectMetaMask() : connectGuest();
        setConn(c);
        setPhase("waiting");
        addLog(`connected ${c.kind === "metamask" ? "MetaMask Smart Account" : "guest wallet"} ${short(c.account.address)}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [addLog],
  );
  // Default Connect: MetaMask if an injected wallet is present, else a guest wallet
  // (keeps the headless e2e — which has no injected wallet — working unchanged).
  const connect = useCallback(() => {
    void connectWith(hasInjectedWallet() ? "metamask" : "guest");
  }, [connectWith]);

  const disconnect = useCallback(() => {
    if (conn?.kind === "guest") clearGuest();
    setConn(null);
    setView(null);
    setPhase("connect");
    paidRef.current = false;
    setPaymentTx(null);
    setHand([]);
    setLegal([]);
    addLog("disconnected");
  }, [conn, addLog]);

  const copyAddr = useCallback(async () => {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  }, [account]);

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
      // Player brings their own USDC: make sure the delegation manager is approved
      // to pull the entry fee (one `approve` — MetaMask popup, or silent for guest).
      const feeWei = BigInt(Math.round(Number(view.fee) * 1e6));
      if (conn) {
        addLog("checking USDC allowance (approve if needed)…");
        await conn.ensureApproval(feeWei);
      }
      addLog(`signing budget delegation + paying ${view.fee} USDC entry fee (x402)…`);
      const res = await client.pay(POT_ADDRESS, view.fee);
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
  }, [client, view, conn, addLog]);

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
          <h1 className="text-4xl font-bold tracking-tight">
            NEXUS <span className="text-uno-yellow">UNO</span>
          </h1>
          <p className="mt-1 text-sm text-white/55">
            Full official ruleset · 108-card deck · gasless moves · x402 entry · sealed hands · on-chain shuffle · Base Sepolia
          </p>
        </div>
        {account ? (
          <div className="flex items-center gap-2">
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{ background: conn?.kind === "metamask" ? "#f6851b22" : "#ffffff14", color: conn?.kind === "metamask" ? "#f6851b" : "#ffffffaa" }}
            >
              {conn?.kind === "metamask" ? "Smart Account" : "Guest"}
            </span>
            <button
              type="button"
              onClick={copyAddr}
              data-testid="wallet-address"
              title="Copy address"
              className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/80 transition hover:bg-white/15"
            >
              <span className="ledger">{short(account.address)}</span>
              <span className="text-white/40">{copied ? "✓ copied" : "⧉"}</span>
            </button>
            <button
              type="button"
              onClick={disconnect}
              data-testid="disconnect"
              title="Disconnect"
              className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/50 transition hover:bg-rose-500/20 hover:text-rose-200"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="text-right text-xs text-white/40 ledger">not connected</div>
        )}
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
        <section className="rounded-3xl border border-white/10 bg-black/25 p-8 shadow-2xl backdrop-blur">
          {phase === "connect" && (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-6 text-center">
              <div className="text-6xl">🃏</div>
              <h2 className="text-2xl font-semibold">Sit down at the table</h2>
              <p className="max-w-md text-white/60">
                Connect <b>MetaMask</b> to join a real game of UNO against the bots — you sign one
                delegation, then every move is gasless. Bring a little Base-Sepolia USDC for the entry fee.
              </p>
              <button
                type="button"
                data-testid="connect"
                onClick={connect}
                className="flex items-center gap-2 rounded-full bg-[#f6851b] px-8 py-3 font-bold text-black transition hover:brightness-110"
              >
                🦊 Connect MetaMask
              </button>
              <button
                type="button"
                data-testid="connect-guest"
                onClick={() => void connectWith("guest")}
                className="text-xs text-white/45 underline-offset-2 hover:text-white/70 hover:underline"
              >
                No wallet? Use a temporary guest wallet
              </button>
            </div>
          )}

          {phase === "waiting" && (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-5 text-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-uno-yellow border-t-transparent" />
              <p className="text-white/70" data-testid="waiting">
                Looking for your seat at the table…
              </p>
              <p className="max-w-sm text-xs text-white/45">
                If no game is waiting for your wallet, start a fresh one — you'll be seated against the bots.
              </p>
              <button
                type="button"
                data-testid="start-game"
                onClick={() => void startGame()}
                disabled={starting}
                className="rounded-full bg-uno-green px-8 py-3 font-bold text-white transition hover:brightness-110 disabled:opacity-50"
              >
                {starting ? "Starting…" : "Start a game"}
              </button>
            </div>
          )}

          {phase === "lobby" && (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-6 text-center">
              <h2 className="text-2xl font-semibold">Buy in to the pot</h2>
              <p className="max-w-md text-white/60">
                The entry fee is <b>{view?.fee ?? "1"} USDC</b>, paid as a real x402 charge from <b>your</b> wallet to the
                Pot at {short(POT_ADDRESS)} — bounded on-chain by your budget delegation.
              </p>
              <button
                type="button"
                data-testid="join-and-pay"
                onClick={pay}
                disabled={busy}
                className="rounded-full bg-uno-green px-8 py-3 font-bold text-white transition hover:brightness-110 disabled:opacity-50"
              >
                {busy ? "Working…" : `Pay ${view?.fee ?? "1"} USDC`}
              </button>
            </div>
          )}

          {phase === "paying" && (
            <div className="flex min-h-[420px] flex-col items-center justify-center gap-4 text-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-uno-yellow border-t-transparent" />
              <p className="text-white/70">Settling your {view?.fee ?? "1"} USDC entry fee on Base Sepolia…</p>
            </div>
          )}

          {(phase === "playing" || phase === "done") && (
            <div className="flex min-h-[420px] flex-col">
              <div className="mb-10 flex items-center justify-center gap-10">
                <div className="flex flex-col items-center gap-2">
                  <div className="text-xs uppercase tracking-widest text-white/40">discard</div>
                  <div data-testid="discard-top">
                    <Card card={topCard} disabled />
                  </div>
                  <div className="ledger text-xs text-white/50" data-testid="active-color">
                    active: {colorName(board.activeColor)} · {view?.direction === -1 ? "↺ ccw" : "↻ cw"}
                  </div>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className="text-xs uppercase tracking-widest text-white/40">draw pile</div>
                  <button
                    type="button"
                    data-testid="draw"
                    onClick={drawCard}
                    disabled={busy || !myTurn || phase === "done"}
                    className="card-face flex h-36 w-24 items-center justify-center rounded-2xl border-2 border-white/15 bg-gradient-to-br from-zinc-800 to-zinc-950 text-3xl font-black text-white/70 disabled:opacity-50"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="mt-auto">
                <div className="mb-3 flex items-center justify-between">
                  <span
                    data-testid="turn-indicator"
                    className={`text-xs uppercase tracking-widest rounded-full px-3 py-1 ${
                      myTurn ? "turn-active text-white" : "text-white/40"
                    }`}
                  >
                    {phase === "done" ? "game over" : myTurn ? "your turn" : "waiting for opponents…"}
                  </span>
                  <button
                    type="button"
                    data-testid="auto-play"
                    onClick={autoPlay}
                    disabled={!myTurn || busy || phase === "done"}
                    className="rounded-full bg-uno-yellow/90 px-4 py-1 text-xs font-bold text-black disabled:opacity-40"
                  >
                    auto-play
                  </button>
                  <span className="ledger text-xs text-white/50">{hand.length} cards</span>
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
          <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/50">Payment</h3>
            {paymentTx ? (
              <div className="space-y-1">
                <div data-testid="payment-status" className="font-bold text-uno-green">
                  PAID · {view?.fee ?? "1"} USDC
                </div>
                <a
                  data-testid="payment-tx"
                  href={`https://sepolia.basescan.org/tx/${paymentTx}`}
                  target="_blank"
                  rel="noreferrer"
                  className="ledger block break-all text-xs text-uno-yellow underline"
                >
                  {paymentTx}
                </a>
              </div>
            ) : (
              <div className="text-sm text-white/40">No entry fee paid yet.</div>
            )}
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/50">Game</h3>
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
                className="ledger mt-2 block break-all text-[10px] text-white/40 underline"
              >
                on-chain shuffle {short(view.shuffleTx)}
              </a>
            )}
            {view?.winner && (
              <div data-testid="winner-banner" className="mt-3 rounded-lg bg-uno-green/15 p-2 text-center text-sm font-bold text-uno-green">
                WINNER {short(view.winner)}
                {view.payoutTx && (
                  <a
                    data-testid="payout-tx"
                    href={`https://sepolia.basescan.org/tx/${view.payoutTx}`}
                    target="_blank"
                    rel="noreferrer"
                    className="ledger mt-1 block break-all text-[10px] font-normal text-uno-yellow underline"
                  >
                    payout {view.payoutTx}
                  </a>
                )}
              </div>
            )}
          </div>

          <div className="flex-1 rounded-2xl border border-white/10 bg-black/30 p-5">
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-widest text-white/50">Activity</h3>
            <div className="ledger max-h-72 space-y-1 overflow-auto text-[11px] leading-relaxed text-white/55">
              {log.length === 0 ? <div className="text-white/30">—</div> : log.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          </div>

          {error && (
            <div className="rounded-2xl border border-uno-red/40 bg-uno-red/10 p-4 text-xs text-uno-red" data-testid="error">
              {error}
            </div>
          )}
        </aside>
      </div>

      {/* Wild color picker */}
      {wildPick && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="rounded-3xl border border-white/10 bg-zinc-900 p-8 text-center shadow-2xl">
            <h3 className="mb-5 text-lg font-semibold">Pick a color for your wild</h3>
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
                  className="h-16 w-16 rounded-2xl border-2 border-white/20 transition hover:scale-110"
                  style={{ background: ["", "#e4002b", "#3aa935", "#0073cf", "#ffcc00"][col] }}
                  aria-label={colorName(col)}
                />
              ))}
            </div>
            <button type="button" onClick={() => setWildPick(null)} className="mt-5 text-xs text-white/40 underline">
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
      <dt className="text-white/40">{k}</dt>
      <dd className="ledger text-white/75">{v}</dd>
    </div>
  );
}
