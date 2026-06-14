"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRIVY_ENABLED } from "./wallet";
import { Board, Pawn, tokenColorFor } from "./components/Board";
import { Dice } from "./components/Dice";
import { MonopolyClient, type GameView } from "@/lib/monopoly-client";
import { BOARD } from "@/lib/board";
import { connectMetaMask, connectGuest, clearGuest, hasInjectedWallet, type Connection } from "@/lib/signer";

// Empty → same-origin /api/* (the backend now lives in this Next app). Only set
// NEXT_PUBLIC_MONOPOLY_BACKEND_URL to talk to a separate origin.
const BACKEND_URL = process.env.NEXT_PUBLIC_MONOPOLY_BACKEND_URL ?? "";

type Phase = "connect" | "waiting" | "lobby" | "playing" | "done";

function short(a?: string | null) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

export default function Page() {
  const [conn, setConn] = useState<Connection | null>(null);
  const account = conn?.account ?? null;
  const [phase, setPhase] = useState<Phase>("connect");
  const [view, setView] = useState<GameView | null>(null);
  const [busy, setBusy] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const [paymentTx, setPaymentTx] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<{ text: string; tx: string } | null>(null);
  const [die, setDie] = useState<{ d1: number; d2: number }>({ d1: 0, d2: 0 });
  const [log, setLog] = useState<string[]>([]);
  const joinedRef = useRef(false);

  const addLog = useCallback((m: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 50));
  }, []);

  const client = useMemo(() => (account ? new MonopolyClient(BACKEND_URL, account) : null), [account]);

  const connectWith = useCallback(
    async (mode: "metamask" | "guest") => {
      setErr(null);
      try {
        const c = mode === "metamask" ? await connectMetaMask() : connectGuest();
        setConn(c);
        setPhase("waiting");
        addLog(`connected ${c.kind === "metamask" ? "MetaMask Smart Account" : "guest wallet"} ${short(c.account.address)}`);
        if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).__MONOPOLY_ADDR__ = c.account.address;
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
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
    joinedRef.current = false;
    setPaymentTx(null);
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
    setErr(null);
    try {
      addLog("starting a game with your wallet…");
      const res = await client.start();
      if (!res.ok) throw new Error(res.error ?? "could not start a game");
      addLog(`game ${res.roomId ?? ""} started — you're seated`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [client, starting, addLog]);

  const me = useMemo(() => {
    if (!account || !view) return null;
    return view.players.find((p) => p.address.toLowerCase() === account.address.toLowerCase()) ?? null;
  }, [account, view]);

  const myTurn = Boolean(account && view?.currentTurn && view.currentTurn.toLowerCase() === account.address.toLowerCase());
  const pending = view?.pending ?? null;

  useEffect(() => {
    if (!client || phase === "connect") return;
    let alive = true;
    const tick = async () => {
      try {
        const st = await client.state();
        if (!alive || !st.ok) return;
        setView(st);
        const seat = account && st.players.find((p) => p.address.toLowerCase() === account.address.toLowerCase());
        setPhase((p) => {
          if (st.winner) return "done";
          if (!seat) return p === "waiting" ? "waiting" : p;
          if (p === "waiting") return "lobby";
          if (p === "lobby" && seat.paid) return "playing";
          return p;
        });
      } catch {
        /* transient */
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [client, phase, account]);

  const join = useCallback(async () => {
    if (!client || !view || joinedRef.current) return;
    joinedRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      // Player brings their own USDC: make sure the delegation manager is approved to
      // pull the buy-in (one `approve` — MetaMask Smart Account UserOp, or silent for guest).
      const buyInWei = BigInt(Math.round(Number(view.fee) * 1e6));
      if (conn) {
        addLog("checking USDC allowance (approve if needed)…");
        await conn.ensureApproval(buyInWei);
      }
      addLog(`signing gameplay + budget delegation, paying ${view.fee} USDC buy-in (x402)…`);
      const res = await client.join(view.roomId, view.pot);
      if (!res.ok || !res.txHash) throw new Error(res.error ?? "buy-in failed");
      setPaymentTx(res.txHash);
      setLastTx({ text: `Buy-in ${view.fee} USDC settled`, tx: res.txHash });
      addLog(`JOINED — buy-in tx ${res.txHash}`);
      setPhase("playing");
    } catch (e) {
      joinedRef.current = false;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [client, view, conn, addLog]);

  const act = useCallback(
    async (action: string, spaceId?: number) => {
      if (!client || !view) return;
      setBusy(true);
      setErr(null);
      if (action === "roll") setRolling(true);
      try {
        const res = await client.act(action, spaceId);
        if (!res.ok) throw new Error(res.error ?? `${action} rejected`);
        if (res.dice) {
          setDie({ d1: res.dice[0], d2: res.dice[1] });
          setLastTx({ text: `Rolled ${res.dice[0]}+${res.dice[1]}`, tx: res.recordTx ?? res.txHash ?? "" });
        } else if (res.txHash) {
          setLastTx({ text: `${action} · settled on-chain`, tx: res.txHash });
        }
        for (const l of res.log ?? []) addLog(l);
        setView(res);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        setTimeout(() => setRolling(false), 500);
      }
    },
    [client, view, addLog],
  );

  // Buildable properties (own a full group, can add a house evenly, affordable).
  const buildable = useMemo(() => {
    if (!view || !me) return [] as number[];
    const out: number[] = [];
    for (const sp of BOARD) {
      if (sp.kind !== "property" || !sp.group) continue;
      const pr = view.properties[sp.id];
      if (!pr || pr.owner?.toLowerCase() !== me.address.toLowerCase() || pr.mortgaged) continue;
      const members = BOARD.filter((s) => s.group === sp.group).map((s) => s.id);
      if (!members.every((m) => view.properties[m]?.owner?.toLowerCase() === me.address.toLowerCase())) continue;
      if (pr.houses >= 5) continue;
      const minH = Math.min(...members.map((m) => view.properties[m].houses));
      if (pr.houses > minH) continue;
      if (members.some((m) => view.properties[m].mortgaged)) continue;
      if ((sp.houseCost ?? 0) > me.cash) continue;
      out.push(sp.id);
    }
    return out;
  }, [view, me]);

  const space = me ? BOARD[me.position % BOARD.length] : BOARD[0];

  // ── connect ──
  if (phase === "connect") {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="panel rounded-3xl p-10 max-w-md w-full text-center">
          <div className="gold-text text-5xl font-bold tracking-tight">NEXUS</div>
          <div className="text-emerald-200/80 tracking-[0.3em] text-sm mt-2">ONCHAIN MONOPOLY</div>
          <p className="text-emerald-100/70 mt-6 text-sm leading-relaxed">
            The <b>full</b> Monopoly ruleset on Base Sepolia. Gasless dice via an onchain randomness
            coordinator; every move is signed by <b>your own</b> wallet via a single Nexus delegation.
            Buy-in, rent, tax and builds settle as <span className="gold-text">real USDC payments</span>{" "}
            from your wallet, bounded on-chain. <b>Win = be the last player not bankrupt.</b>
          </p>
          <button data-testid="login-btn" onClick={connect} className="btn btn-primary w-full mt-8 py-3 text-base">
            {hasInjectedWallet() ? "🦊 Connect MetaMask" : PRIVY_ENABLED ? "Log in with Privy" : "Play as Guest"}
          </button>
          <button
            type="button"
            data-testid="connect-guest"
            onClick={() => void connectWith("guest")}
            className="block w-full mt-3 text-emerald-300/50 text-[11px] hover:text-emerald-200/80 underline-offset-2 hover:underline"
          >
            No wallet? Use a temporary guest wallet
          </button>
          <div className="text-emerald-300/50 text-[11px] mt-4">
            MetaMask derives a Hybrid smart account · bring a little Base-Sepolia USDC for the buy-in
          </div>
          {err && <div className="mt-4 rounded-xl p-3 bg-rose-950/60 border border-rose-500/40 text-rose-200 text-xs" data-testid="error">{err}</div>}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="flex items-center justify-between mb-5">
          <div>
            <span className="gold-text text-2xl font-bold tracking-tight">NEXUS</span>
            <span className="text-emerald-200/70 text-sm ml-2 tracking-[0.25em]">MONOPOLY · FULL RULES</span>
          </div>
          {account ? (
            <div className="flex items-center gap-2">
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                style={{ background: conn?.kind === "metamask" ? "#f6851b22" : "#10b98122", color: conn?.kind === "metamask" ? "#f6851b" : "#6ee7b7" }}
              >
                {conn?.kind === "metamask" ? "Smart Account" : "Guest"}
              </span>
              <button
                type="button"
                onClick={copyAddr}
                data-testid="wallet-address"
                title="Copy address"
                className="panel mono flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs text-emerald-100 transition hover:brightness-125"
              >
                <span>{short(account.address)}</span>
                <span className="text-emerald-300/50">{copied ? "✓" : "⧉"}</span>
              </button>
              <button
                type="button"
                onClick={disconnect}
                data-testid="disconnect"
                title="Disconnect"
                className="rounded-xl px-3 py-1.5 text-xs text-emerald-300/50 transition hover:bg-rose-500/20 hover:text-rose-200"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="panel rounded-xl px-3 py-1.5 text-right">
              <div className="text-[10px] text-emerald-300/60 uppercase tracking-wider">not connected</div>
              <div data-testid="wallet-address" className="mono text-xs text-emerald-100">—</div>
            </div>
          )}
        </header>

        <div className="grid lg:grid-cols-[1fr_360px] gap-6">
          <div>
            <Board players={view?.players ?? []} properties={view?.properties ?? {}} meAddress={account?.address ?? null} />
          </div>

          <aside className="space-y-4">
            {phase === "waiting" && (
              <div className="panel rounded-2xl p-6 text-center" data-testid="waiting">
                <div className="h-8 w-8 mx-auto animate-spin rounded-full border-4 border-emerald-400 border-t-transparent" />
                <p className="text-emerald-200/70 text-sm mt-3">Looking for your seat at the table…</p>
                <p className="text-emerald-300/50 text-[11px] mt-2">
                  If no game is waiting for your wallet, start a fresh one — you'll be seated against the bots.
                </p>
                <button
                  type="button"
                  data-testid="start-game"
                  onClick={() => void startGame()}
                  disabled={starting}
                  className="btn btn-gold w-full mt-4 py-2.5 disabled:opacity-50"
                >
                  {starting ? "Starting…" : "Start a game"}
                </button>
              </div>
            )}

            {phase === "lobby" && (
              <div className="panel rounded-2xl p-5 text-center">
                <div className="text-sm text-emerald-100/80 mb-3">
                  Buy in to the pot — <b>{view?.fee} USDC</b>, a real x402 charge from <b>your</b> wallet to the
                  Pot {short(view?.pot)}, bounded on-chain by your budget delegation.
                </div>
                <button data-testid="join-btn" onClick={join} disabled={busy} className="btn btn-gold w-full py-3">
                  {busy ? "Paying buy-in…" : `Join · pay ${view?.fee} USDC`}
                </button>
              </div>
            )}

            {(phase === "playing" || phase === "done") && view && (
              <>
                {/* players */}
                <div className="panel rounded-2xl p-4">
                  <div className="text-[11px] text-emerald-300/60 uppercase tracking-wider mb-2">Players · round {view.round}/{view.roundCap}</div>
                  <ul className="space-y-1.5" data-testid="players">
                    {view.players.map((p) => {
                      const isCur = view.currentTurn?.toLowerCase() === p.address.toLowerCase();
                      return (
                        <li key={p.address} className={`flex items-center justify-between text-xs rounded-lg px-2 py-1.5 ${p.bankrupt ? "opacity-40 line-through" : ""} ${isCur ? "bg-emerald-500/15 ring-1 ring-emerald-400/40" : "bg-black/20"}`}>
                          <span className="flex items-center gap-2">
                            <Pawn color={tokenColorFor(view.players, p.address)} size={18} />
                            <span className="font-semibold">{p.name}</span>
                            {isCur && <span className="text-[9px] text-emerald-300">●</span>}
                            {p.inJail && <span className="text-[9px] text-rose-300">JAIL</span>}
                          </span>
                          <span className="flex items-center gap-3">
                            <span className="mono text-emerald-200">${p.cash}</span>
                            <span className="text-emerald-300/50 text-[10px]">{p.properties.length}🏠</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {/* dice + actions */}
                <div className="panel rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[11px] text-emerald-300/60 uppercase tracking-wider">Onchain dice</div>
                    <div className="text-[10px] text-emerald-300/40">on {space.name}</div>
                  </div>
                  <div className="flex items-center justify-center py-2">
                    <Dice die1={die.d1} die2={die.d2} rolling={rolling} />
                  </div>

                  <div className="mb-2 text-center text-[11px]">
                    <span data-testid="turn-indicator" className={myTurn ? "gold-text font-bold" : "text-emerald-200/40"}>
                      {phase === "done" ? "game over" : myTurn ? "your turn" : "waiting for opponents…"}
                    </span>
                  </div>

                  {phase === "done" ? (
                    <div className="text-center text-emerald-300/70 text-sm py-2">Game over.</div>
                  ) : !myTurn ? (
                    <button disabled className="btn btn-primary w-full py-3 opacity-50">Wait for your turn</button>
                  ) : me?.inJail && !view.rolledThisTurn ? (
                    <div className="space-y-2">
                      <button data-testid="payjail-btn" onClick={() => act("payJail")} disabled={busy} className="btn btn-gold w-full py-2.5">
                        {me.getOutCards > 0 ? "Use Get-Out-of-Jail card" : "Pay $50 to leave jail"}
                      </button>
                      <button data-testid="roll-btn" onClick={() => act("roll")} disabled={busy} className="btn btn-primary w-full py-2.5">
                        {busy ? "Rolling…" : "Roll for doubles"}
                      </button>
                    </div>
                  ) : pending?.kind === "buy" ? (
                    <div className="space-y-2">
                      <button data-testid="buy-btn" onClick={() => act("buy")} disabled={busy || (me?.cash ?? 0) < pending.price} className="btn btn-primary w-full py-2.5">
                        {busy ? "Buying…" : `Buy ${BOARD[pending.spaceId].name} · $${pending.price}`}
                      </button>
                      <button data-testid="decline-btn" onClick={() => act("decline")} disabled={busy} className="btn btn-ghost w-full py-2">
                        Decline
                      </button>
                    </div>
                  ) : !view.rolledThisTurn ? (
                    <button data-testid="roll-btn" onClick={() => act("roll")} disabled={busy} className="btn btn-primary w-full py-3">
                      {busy ? "Rolling onchain…" : "Roll dice"}
                    </button>
                  ) : (
                    <div className="space-y-2">
                      {buildable.length > 0 && (
                        <div className="grid grid-cols-1 gap-1">
                          {buildable.map((sid) => (
                            <button key={sid} data-testid={`build-${sid}`} onClick={() => act("build", sid)} disabled={busy} className="btn btn-gold w-full py-2 text-xs">
                              Build on {BOARD[sid].name} · ${BOARD[sid].houseCost}
                            </button>
                          ))}
                        </div>
                      )}
                      <button data-testid="end-btn" onClick={() => act("end")} disabled={busy} className="btn btn-primary w-full py-2.5">
                        {busy ? "…" : "End turn"}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {paymentTx && (
              <div className="panel rounded-2xl p-4">
                <div className="text-[11px] text-emerald-300/60 uppercase tracking-wider mb-1">Buy-in</div>
                <div data-testid="payment-status" className="text-sm font-bold text-emerald-300">PAID · {view?.fee} USDC</div>
                <a data-testid="payment-tx" className="tx-link text-xs mono break-all block" href={`https://sepolia.basescan.org/tx/${paymentTx}`} target="_blank" rel="noreferrer">{paymentTx}</a>
              </div>
            )}

            {lastTx?.tx && (
              <div className="panel rounded-2xl p-4" data-testid="last-tx">
                <div className="text-[11px] text-emerald-300/60 uppercase tracking-wider mb-1">Settled onchain</div>
                <div className="text-sm text-emerald-100">{lastTx.text}</div>
                <a className="tx-link text-xs mono break-all" href={`https://sepolia.basescan.org/tx/${lastTx.tx}`} target="_blank" rel="noreferrer">{lastTx.tx}</a>
              </div>
            )}

            {view?.winner && (
              <div data-testid="winner-banner" className="panel rounded-2xl p-4 text-center text-sm font-bold text-emerald-300">
                WINNER {short(view.winner)} (last solvent)
                {view.payoutTx && (
                  <a data-testid="payout-tx" className="tx-link block mono text-[10px] font-normal break-all mt-1" href={`https://sepolia.basescan.org/tx/${view.payoutTx}`} target="_blank" rel="noreferrer">
                    {view.payoutTx}
                  </a>
                )}
              </div>
            )}

            {err && <div className="rounded-2xl p-3 bg-rose-950/60 border border-rose-500/40 text-rose-200 text-xs" data-testid="error">{err}</div>}

            <div className="panel rounded-2xl p-4">
              <div className="text-[11px] text-emerald-300/60 uppercase tracking-wider mb-2">Activity</div>
              <ul className="space-y-1 max-h-56 overflow-auto text-[11px] text-emerald-100/70" data-testid="log">
                {log.length === 0 ? <li className="text-emerald-200/40">No moves yet.</li> : log.map((l, i) => <li key={i}>{l}</li>)}
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
