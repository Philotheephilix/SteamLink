"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PRIVY_ENABLED } from "@/lib/monopoly/wallet";
import { Board, Pawn, tokenColorFor } from "@/components/monopoly/Board";
import { Dice } from "@/components/monopoly/Dice";
import { MonopolyClient, type GameView } from "@/lib/monopoly/monopoly-client";
import { BOARD } from "@/lib/monopoly/board";
import { hasInjectedWallet } from "@/lib/wallet";
import { useWallet } from "@/components/wallet/WalletProvider";
import { linkifyTx } from "@/components/linkifyTx";
import { addresses as monoAddresses } from "@/lib/monopoly/deployment";

const MONOPOLY_MANAGER = monoAddresses.delegationManager;

// Empty → same-origin /api/* (the backend now lives in this Next app). Only set
// NEXT_PUBLIC_MONOPOLY_BACKEND_URL to talk to a separate origin.
const BACKEND_URL = process.env.NEXT_PUBLIC_MONOPOLY_BACKEND_URL ?? "";

type Phase = "connect" | "waiting" | "lobby" | "playing" | "done";

function short(a?: string | null) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

export default function Page() {
  // Shared, app-wide wallet (one connector for the whole site — see WalletProvider).
  const wallet = useWallet();
  const conn = wallet.connection;
  const account = conn?.account ?? null;
  const grant = wallet.grant;
  const copied = wallet.copied;
  const [phase, setPhase] = useState<Phase>("connect");
  const [view, setView] = useState<GameView | null>(null);
  const [busy, setBusy] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [paymentTx, setPaymentTx] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<{ text: string; tx: string } | null>(null);
  const [die, setDie] = useState<{ d1: number; d2: number }>({ d1: 0, d2: 0 });
  const [log, setLog] = useState<string[]>([]);
  const joinedRef = useRef(false);
  const grantStoredRef = useRef(false);

  const addLog = useCallback((m: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 50));
  }, []);

  const client = useMemo(() => (account ? new MonopolyClient(BACKEND_URL, account) : null), [account]);

  // On connect → lobby; once an ERC-7715 grant exists, store it with the Monopoly backend.
  useEffect(() => {
    if (account && phase === "connect") setPhase("waiting");
    if (account && typeof window !== "undefined") (window as unknown as Record<string, unknown>).__MONOPOLY_ADDR__ = account.address;
  }, [account, phase]);
  useEffect(() => {
    if (!account || !grant || grantStoredRef.current) return;
    grantStoredRef.current = true;
    void new MonopolyClient(BACKEND_URL, account)
      .grantSpend(grant)
      .then((r) => addLog(r.ok ? `spend permission stored — up to ${grant.capUsd} USDC/day` : `grant store failed: ${r.error}`))
      .catch((e) => addLog(`grant store failed: ${e instanceof Error ? e.message : String(e)}`));
  }, [account, grant, addLog]);

  const connectWith = useCallback(
    async (mode: "metamask" | "guest") => {
      const c = await wallet.connect(mode);
      if (c) addLog(`connected ${c.kind === "metamask" ? "MetaMask Smart Account" : "guest wallet"} ${short(c.account.address)}`);
      if (wallet.error) setErr(wallet.error);
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
    joinedRef.current = false;
    grantStoredRef.current = false;
    setPaymentTx(null);
    addLog("disconnected");
  }, [wallet, addLog]);

  const copyAddr = wallet.copyAddress;

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
      // MetaMask rail with an ERC-7715 grant: the spend is already authorized by
      // MetaMask's native popup, redeemed via the canonical DelegationManager — no
      // budget delegation, no `approve`, no second signature.
      const useGrant = conn?.kind === "metamask" && grant !== null;
      let res: { ok: boolean; txHash?: string; error?: string };
      if (useGrant) {
        addLog(`signing gameplay delegation, paying ${view.fee} USDC buy-in via your MetaMask spend permission (x402)…`);
        res = await client.joinViaGrant(view.roomId);
      } else {
        // GUEST rail: bring your own USDC — approve the delegation manager, then sign +
        // redeem our custom budget delegation (unchanged; keeps the e2e working).
        const buyInWei = BigInt(Math.round(Number(view.fee) * 1e6));
        if (conn) {
          addLog("checking USDC allowance (approve if needed)…");
          await conn.ensureApproval(MONOPOLY_MANAGER, buyInWei);
        }
        addLog(`signing gameplay + budget delegation, paying ${view.fee} USDC buy-in (x402)…`);
        res = await client.join(view.roomId, view.pot);
      }
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
  }, [client, view, conn, grant, addLog]);

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
        <div className="sticker rounded-chunk bg-paper p-10 max-w-md w-full text-center shadow-sticker-lg">
          <div className="font-display text-5xl font-extrabold tracking-tight text-grape">NEXUS</div>
          <div className="text-ink-faint tracking-[0.3em] text-sm mt-2 font-semibold uppercase">Onchain Monopoly</div>
          <p className="text-ink-soft mt-6 text-sm leading-relaxed">
            The <b>full</b> Monopoly ruleset on Base Sepolia. Gasless dice via an onchain randomness
            coordinator; every move is signed by <b>your own</b> wallet via a single Nexus delegation.
            Buy-in, rent, tax and builds settle as <span className="text-grape font-bold">real USDC payments</span>{" "}
            from your wallet, bounded on-chain. <b>Win = be the last player not bankrupt.</b>
          </p>
          <button
            data-testid="login-btn"
            onClick={connect}
            className="sticker sticker-lift sticker-press w-full mt-8 py-3 text-base rounded-chunk bg-grape text-paper font-display font-extrabold tracking-wide"
          >
            {hasInjectedWallet() ? "🦊 Connect MetaMask" : PRIVY_ENABLED ? "Log in with Privy" : "Play as Guest"}
          </button>
          <button
            type="button"
            data-testid="connect-guest"
            onClick={() => void connectWith("guest")}
            className="block w-full mt-3 text-ink-faint text-[11px] hover:text-ink-soft underline-offset-2 hover:underline"
          >
            No wallet? Use a temporary guest wallet
          </button>
          <div className="text-ink-faint text-[11px] mt-4">
            MetaMask derives a Hybrid smart account · bring a little Base-Sepolia USDC for the buy-in
          </div>
          {err && <div className="mt-4 rounded-chunk p-3 bg-berry/10 border-[2px] border-berry/40 text-berry text-xs font-semibold" data-testid="error">{err}</div>}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl border-[2.5px] border-ink bg-grape text-paper font-display text-lg font-extrabold shadow-sticker-sm">
              MO
            </span>
            <div>
              <span className="font-display text-xl font-extrabold tracking-tight text-ink">NEXUS</span>
              <span className="text-ink-faint text-xs ml-2 tracking-[0.2em] uppercase font-semibold">Monopoly · Full Rules</span>
            </div>
          </div>
          {account ? (
            <div className="flex items-center gap-2">
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide border-[2px] border-ink"
                style={{ background: conn?.kind === "metamask" ? "oklch(0.56 0.17 300 / 0.15)" : "oklch(0.71 0.15 150 / 0.15)", color: conn?.kind === "metamask" ? "oklch(0.56 0.17 300)" : "oklch(0.71 0.15 150)" }}
              >
                {conn?.kind === "metamask" ? "Smart Account" : "Guest"}
              </span>
              <button
                type="button"
                onClick={copyAddr}
                data-testid="wallet-address"
                title="Copy address"
                className="sticker sticker-lift sticker-press rounded-chunk px-3 py-1.5 text-xs text-ink font-mono bg-paper flex items-center gap-1.5"
              >
                <span>{short(account.address)}</span>
                <span className="text-ink-faint">{copied ? "✓" : "⧉"}</span>
              </button>
              <button
                type="button"
                onClick={disconnect}
                data-testid="disconnect"
                title="Disconnect"
                className="rounded-chunk px-3 py-1.5 text-xs text-ink-faint border-[2px] border-ink/20 hover:border-berry/40 hover:text-berry transition-colors"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="sticker rounded-chunk px-3 py-1.5 bg-paper text-right">
              <div className="text-[10px] text-ink-faint uppercase tracking-wider font-semibold">not connected</div>
              <div data-testid="wallet-address" className="font-mono text-xs text-ink">—</div>
            </div>
          )}
        </header>

        <div className="grid lg:grid-cols-[1fr_360px] gap-6">
          <div>
            <Board players={view?.players ?? []} properties={view?.properties ?? {}} meAddress={account?.address ?? null} />
          </div>

          <aside className="space-y-4">
            {phase === "waiting" && (
              <div className="sticker rounded-chunk bg-paper p-6 text-center" data-testid="waiting">
                <div className="h-8 w-8 mx-auto animate-spin rounded-full border-4 border-grape border-t-transparent" />
                <p className="text-ink-soft text-sm mt-3">Looking for your seat at the table…</p>
                <p className="text-ink-faint text-[11px] mt-2">
                  If no game is waiting for your wallet, start a fresh one — you'll be seated against the bots.
                </p>
                <button
                  type="button"
                  data-testid="start-game"
                  onClick={() => void startGame()}
                  disabled={starting}
                  className="sticker sticker-lift sticker-press w-full mt-4 py-2.5 rounded-chunk bg-grape text-paper font-display font-extrabold tracking-wide disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {starting ? "Starting…" : "Start a game"}
                </button>
              </div>
            )}

            {phase === "lobby" && (
              <div className="sticker rounded-chunk bg-paper p-5 text-center">
                <div className="text-sm text-ink-soft mb-3">
                  Buy in to the pot — <b className="text-ink">{view?.fee} USDC</b>, a real x402 charge from <b className="text-ink">your</b> wallet to the
                  Pot {short(view?.pot)}, bounded on-chain by your budget delegation.
                </div>
                <button
                  data-testid="join-btn"
                  onClick={join}
                  disabled={busy}
                  className="sticker sticker-lift sticker-press w-full py-3 rounded-chunk bg-grape text-paper font-display font-extrabold tracking-wide disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {busy ? "Paying buy-in…" : `Join · pay ${view?.fee} USDC`}
                </button>
              </div>
            )}

            {(phase === "playing" || phase === "done") && view && (
              <>
                {/* players */}
                <div className="sticker rounded-chunk bg-paper p-4">
                  <div className="text-[11px] text-ink-faint uppercase tracking-wider mb-2 font-bold">Players · round {view.round}/{view.roundCap}</div>
                  <ul className="space-y-1.5" data-testid="players">
                    {view.players.map((p) => {
                      const isCur = view.currentTurn?.toLowerCase() === p.address.toLowerCase();
                      return (
                        <li key={p.address} className={`flex items-center justify-between text-xs rounded-xl px-2 py-1.5 border-[2px] ${p.bankrupt ? "opacity-40 line-through border-ink/10 bg-paper-dark" : ""} ${isCur ? "border-grape/60 bg-grape/10" : "border-ink/10 bg-paper-deep"}`}>
                          <span className="flex items-center gap-2">
                            <Pawn color={tokenColorFor(view.players, p.address)} size={18} />
                            <span className="font-bold text-ink">{p.name}</span>
                            {isCur && <span className="text-[9px] text-grape font-bold">●</span>}
                            {p.inJail && <span className="text-[9px] text-berry font-bold">JAIL</span>}
                          </span>
                          <span className="flex items-center gap-3">
                            <span className="font-mono text-ink font-semibold">${p.cash}</span>
                            <span className="text-ink-faint text-[10px]">{p.properties.length}🏠</span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {/* dice + actions */}
                <div className="sticker rounded-chunk bg-paper p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-[11px] text-ink-faint uppercase tracking-wider font-bold">Onchain dice</div>
                    <div className="text-[10px] text-ink-faint font-mono">on {space.name}</div>
                  </div>
                  <div className="flex items-center justify-center py-2">
                    <Dice die1={die.d1} die2={die.d2} rolling={rolling} />
                  </div>

                  <div className="mb-2 text-center text-[11px]">
                    <span data-testid="turn-indicator" className={myTurn ? "text-grape font-extrabold" : "text-ink-faint"}>
                      {phase === "done" ? "game over" : myTurn ? "your turn" : "waiting for opponents…"}
                    </span>
                  </div>

                  {phase === "done" ? (
                    <div className="text-center text-ink-soft text-sm py-2">Game over.</div>
                  ) : !myTurn ? (
                    <button disabled className="sticker w-full py-3 rounded-chunk bg-paper-deep text-ink-faint font-display font-extrabold opacity-50 cursor-not-allowed">Wait for your turn</button>
                  ) : me?.inJail && !view.rolledThisTurn ? (
                    <div className="space-y-2">
                      <button data-testid="payjail-btn" onClick={() => act("payJail")} disabled={busy} className="sticker sticker-lift sticker-press w-full py-2.5 rounded-chunk bg-amber text-ink font-display font-extrabold disabled:opacity-50">
                        {me.getOutCards > 0 ? "Use Get-Out-of-Jail card" : "Pay $50 to leave jail"}
                      </button>
                      <button data-testid="roll-btn" onClick={() => act("roll")} disabled={busy} className="sticker sticker-lift sticker-press w-full py-2.5 rounded-chunk bg-grape text-paper font-display font-extrabold disabled:opacity-50">
                        {busy ? "Rolling…" : "Roll for doubles"}
                      </button>
                    </div>
                  ) : pending?.kind === "buy" ? (
                    <div className="space-y-2">
                      <button data-testid="buy-btn" onClick={() => act("buy")} disabled={busy || (me?.cash ?? 0) < pending.price} className="sticker sticker-lift sticker-press w-full py-2.5 rounded-chunk bg-grape text-paper font-display font-extrabold disabled:opacity-50">
                        {busy ? "Buying…" : `Buy ${BOARD[pending.spaceId].name} · $${pending.price}`}
                      </button>
                      <button data-testid="decline-btn" onClick={() => act("decline")} disabled={busy} className="sticker sticker-lift sticker-press w-full py-2 rounded-chunk bg-paper-deep text-ink-soft font-display font-bold disabled:opacity-50">
                        Decline
                      </button>
                    </div>
                  ) : !view.rolledThisTurn ? (
                    <button data-testid="roll-btn" onClick={() => act("roll")} disabled={busy} className="sticker sticker-lift sticker-press w-full py-3 rounded-chunk bg-grape text-paper font-display font-extrabold disabled:opacity-50">
                      {busy ? "Rolling onchain…" : "Roll dice"}
                    </button>
                  ) : (
                    <div className="space-y-2">
                      {buildable.length > 0 && (
                        <div className="grid grid-cols-1 gap-1">
                          {buildable.map((sid) => (
                            <button key={sid} data-testid={`build-${sid}`} onClick={() => act("build", sid)} disabled={busy} className="sticker sticker-lift sticker-press w-full py-2 rounded-chunk bg-grass text-ink font-display font-bold text-xs disabled:opacity-50">
                              Build on {BOARD[sid].name} · ${BOARD[sid].houseCost}
                            </button>
                          ))}
                        </div>
                      )}
                      <button data-testid="end-btn" onClick={() => act("end")} disabled={busy} className="sticker sticker-lift sticker-press w-full py-2.5 rounded-chunk bg-grape text-paper font-display font-extrabold disabled:opacity-50">
                        {busy ? "…" : "End turn"}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}

            {paymentTx && (
              <div className="sticker rounded-chunk bg-paper p-4">
                <div className="text-[11px] text-ink-faint uppercase tracking-wider mb-1 font-bold">Buy-in</div>
                <div data-testid="payment-status" className="text-sm font-extrabold text-grape font-display">PAID · {view?.fee} USDC</div>
                <a data-testid="payment-tx" className="text-xs font-mono break-all block text-grape/70 hover:text-grape underline underline-offset-2" href={`https://sepolia.basescan.org/tx/${paymentTx}`} target="_blank" rel="noreferrer">{paymentTx}</a>
              </div>
            )}

            {lastTx?.tx && (
              <div className="sticker rounded-chunk bg-paper p-4" data-testid="last-tx">
                <div className="text-[11px] text-ink-faint uppercase tracking-wider mb-1 font-bold">Settled onchain</div>
                <div className="text-sm text-ink font-semibold">{lastTx.text}</div>
                <a className="text-xs font-mono break-all text-grape/70 hover:text-grape underline underline-offset-2" href={`https://sepolia.basescan.org/tx/${lastTx.tx}`} target="_blank" rel="noreferrer">{lastTx.tx}</a>
              </div>
            )}

            {view?.winner && (
              <div data-testid="winner-banner" className="sticker rounded-chunk bg-grape p-4 text-center text-sm font-extrabold font-display text-paper">
                WINNER {short(view.winner)} (last solvent)
                {view.payoutTx && (
                  <a data-testid="payout-tx" className="block font-mono text-[10px] font-normal break-all mt-1 text-paper/70 hover:text-paper underline underline-offset-2" href={`https://sepolia.basescan.org/tx/${view.payoutTx}`} target="_blank" rel="noreferrer">
                    {view.payoutTx}
                  </a>
                )}
              </div>
            )}

            {err && <div className="rounded-chunk p-3 bg-berry/10 border-[2px] border-berry/40 text-berry text-xs font-semibold" data-testid="error">{err}</div>}

            <div className="sticker rounded-chunk bg-paper p-4">
              <div className="text-[11px] text-ink-faint uppercase tracking-wider mb-2 font-bold">Activity</div>
              <ul className="space-y-1 max-h-56 overflow-auto text-[11px] text-ink-soft" data-testid="log">
                {log.length === 0 ? <li className="text-ink-faint">No moves yet.</li> : log.map((l, i) => <li key={i} className="break-all">{linkifyTx(l, "text-grape underline underline-offset-2 hover:opacity-80")}</li>)}
              </ul>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}
