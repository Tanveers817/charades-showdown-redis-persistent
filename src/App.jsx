import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const AVATARS = ["🎭", "🦊", "🐸", "🐼", "🦄", "🐙", "🐯", "🐵"];
const socket = io({
  autoConnect: false,
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 500,
  reconnectionDelayMax: 5000,
  timeout: 10000
});

function CanvasBoard({ enabled, onStroke, onClear, remoteVersion }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);
  const ctx = () => canvasRef.current?.getContext("2d");
  const point = e => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const draw = pts => {
    const c = canvasRef.current, context = ctx();
    if (!c || !context || pts.length < 2) return;
    context.strokeStyle = "#20243a"; context.lineWidth = 4; context.lineCap = "round"; context.lineJoin = "round";
    const rect = c.getBoundingClientRect();
    context.beginPath(); context.moveTo(pts[0].x * rect.width, pts[0].y * rect.height);
    for (const p of pts.slice(1)) context.lineTo(p.x * rect.width, p.y * rect.height);
    context.stroke();
  };
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = c.getBoundingClientRect();
    c.width = Math.max(1, Math.floor(rect.width * dpr));
    c.height = Math.max(1, Math.floor(rect.height * dpr));
    const context = c.getContext("2d"); context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);
  useEffect(() => { if (remoteVersion?.type === "clear") ctx()?.clearRect(0, 0, canvasRef.current.getBoundingClientRect().width, canvasRef.current.getBoundingClientRect().height); else if (remoteVersion?.points) draw(remoteVersion.points); }, [remoteVersion]);
  const start = e => { if (!enabled) return; drawing.current = true; last.current = point(e); canvasRef.current.setPointerCapture(e.pointerId); };
  const move = e => {
    if (!drawing.current || !enabled) return;
    const p = point(e), prev = last.current; draw([prev, p]); last.current = p;
    onStroke([prev, p]);
  };
  const stop = () => { drawing.current = false; last.current = null; };
  return <div className="canvas-wrap"><canvas ref={canvasRef} onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} /><div className="canvas-hint">{enabled ? "Draw here with your finger or mouse" : "The performer's drawing appears here"}</div><button className="small ghost clear" disabled={!enabled} onClick={() => { ctx()?.clearRect(0, 0, canvasRef.current.getBoundingClientRect().width, canvasRef.current.getBoundingClientRect().height); onClear(); }}>Clear</button></div>;
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [screen, setScreen] = useState("home");
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [codeInput, setCodeInput] = useState("");
  const [room, setRoom] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [notice, setNotice] = useState("");
  const [guess, setGuess] = useState("");
  const [seconds, setSeconds] = useState(60);
  const [answerReveal, setAnswerReveal] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [remoteStroke, setRemoteStroke] = useState(null);
  const [lastCorrect, setLastCorrect] = useState("");
  const timerRef = useRef(null);
  const me = room?.players?.find(p => p.id === socket.id);
  const isHost = room?.hostId === socket.id;
  const isPerformer = room?.turn?.performerId === socket.id;
  const alreadyGuessed = room?.turn?.correctPlayerIds?.includes(socket.id);
  const joinCode = room?.code;

  useEffect(() => {
    socket.connect();
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => { setConnected(false); setNotice("Connection lost. Reconnecting…"); });
    socket.on("room:update", data => {
      setRoom(data);
      if (data.status === "lobby") setScreen("lobby");
      if (data.status === "playing") setScreen("game");
      if (data.status === "finished") setScreen("results");
    });
    socket.on("turn:prompt", data => { setPrompt(data); setAnswerReveal(null); setGuess(""); });
    socket.on("turn:started", data => { setSeconds(Math.max(0, Math.ceil((data.endsAt - Date.now()) / 1000))); setRemoteStroke(null); setLastCorrect(""); });
    socket.on("turn:passed", () => setRemoteStroke(null));
    socket.on("turn:ended", data => { setAnswerReveal(data); setPrompt(null); });
    socket.on("game:finished", data => { setLeaderboard(data.leaderboard); setScreen("results"); });
    socket.on("guess:correct", data => setLastCorrect(`${data.playerName} guessed it${data.firstCorrect ? " first!" : "!"}`));
    socket.on("draw:stroke", data => setRemoteStroke({ ...data, type: "stroke", points: data.points }));
    socket.on("draw:clear", () => setRemoteStroke({ type: "clear" }));
    return () => {
      socket.off("connect"); socket.off("disconnect"); socket.off("room:update"); socket.off("turn:prompt");
      socket.off("turn:started"); socket.off("turn:passed"); socket.off("turn:ended"); socket.off("game:finished");
      socket.off("guess:correct"); socket.off("draw:stroke"); socket.off("draw:clear");
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!room?.turn?.endsAt || room.status !== "playing") return;
    const tick = () => setSeconds(Math.max(0, Math.ceil((room.turn.endsAt - Date.now()) / 1000)));
    tick(); timerRef.current = setInterval(tick, 250);
    return () => clearInterval(timerRef.current);
  }, [room?.turn?.endsAt, room?.status]);

  const call = useCallback((event, payload = {}) => new Promise(resolve => {
    socket.timeout(5000).emit(event, payload, (err, result) => resolve(err ? { ok: false, error: "Server did not respond. Please try again." } : result));
  }), []);
  const createRoom = async () => {
    if (!name.trim()) return setNotice("Enter your name first.");
    const res = await call("room:create", { name, avatar });
    if (res.ok) { setRoom(res.room); setScreen("lobby"); setNotice(""); } else setNotice(res.error);
  };
  const joinRoom = async () => {
    if (!name.trim() || !codeInput.trim()) return setNotice("Enter your name and room code.");
    const res = await call("room:join", { name, avatar, code: codeInput.trim() });
    if (res.ok) { setRoom(res.room); setScreen("lobby"); setNotice(""); } else setNotice(res.error);
  };
  const ready = async () => { const res = await call("player:ready", { ready: !me?.ready }); if (!res.ok) setNotice(res.error || "Could not update ready status."); };
  const start = async () => { const res = await call("game:start"); if (!res.ok) setNotice(res.error); };
  const submitGuess = async e => {
    e?.preventDefault(); if (!guess.trim()) return;
    const res = await call("guess:submit", { guess });
    if (!res.ok) setNotice(res.error);
    else if (res.correct) { setNotice(`Correct! +${res.points} points`); setGuess(""); }
    else setNotice("Not quite — try again!");
  };
  const pass = async () => { const res = await call("turn:pass"); if (!res.ok) setNotice(res.error); };
  const sendStroke = points => socket.volatile.emit("draw:stroke", { points, color: "#20243a", width: 4 });
  const clearDrawing = () => socket.emit("draw:clear");
  const copyCode = async () => { try { await navigator.clipboard.writeText(joinCode); setNotice("Room code copied!"); } catch { setNotice(`Room code: ${joinCode}`); } };
  const sortedPlayers = useMemo(() => [...(room?.players || [])].sort((a,b) => b.score-a.score), [room?.players]);

  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-icon">🎭</span><span>CHARADES <b>SHOWDOWN</b></span></div><span className={`connection ${connected ? "online" : ""}`}><i />{connected ? "Connected" : "Connecting…"}</span></header>
    <section className="main">
      {screen === "home" && <div className="hero">
        <div className="eyebrow">THE PARTY GAME FOR EVERYONE</div><h1>Act it. Draw it.<br/><em>Guess it.</em></h1>
        <p className="sub">Bring your friends together for a fast, hilarious showdown. No downloads or accounts needed — just a room code.</p>
        <div className="home-card">
          <label>Your display name</label><input value={name} maxLength={18} onChange={e=>setName(e.target.value)} placeholder="Enter your name" />
          <label>Choose your avatar</label><div className="avatars">{AVATARS.map(a=><button key={a} className={`avatar ${avatar===a?"selected":""}`} onClick={()=>setAvatar(a)}>{a}</button>)}</div>
          <button className="primary wide" onClick={createRoom}>＋ Create a room</button>
          <div className="or"><span>OR JOIN FRIENDS</span></div>
          <div className="join-row"><input aria-label="Room code" value={codeInput} maxLength={6} onChange={e=>setCodeInput(e.target.value.toUpperCase())} placeholder="6-CHARACTER CODE" /><button className="secondary" onClick={joinRoom}>Join room</button></div>
          {notice && <div className="notice">{notice}</div>}
        </div>
        <div className="feature-row"><span>⚡ Real-time play</span><span>👥 2–8 players</span><span>✏️ Act + Draw</span></div>
      </div>}

      {screen === "lobby" && room && <div className="panel">
        <div className="eyebrow">WAITING ROOM</div><h2>Gather your crew</h2><p className="sub">Share the room code with your friends. Up to 8 players can join.</p>
        <div className="code-card"><span>ROOM CODE</span><strong>{room.code}</strong><button className="secondary" onClick={copyCode}>Copy code</button></div>
        <div className="players-head"><b>Players ({room.players.length}/8)</b><span>{room.players.filter(p=>p.ready || p.id===room.hostId).length} ready</span></div>
        <div className="player-grid">{room.players.map((p,i)=><div className="player-tile" key={p.id}><span className="player-avatar">{p.avatar}</span><div><b>{p.name}</b><small>{p.id===room.hostId?"HOST":p.ready?"READY":"NOT READY"}</small></div><span className="presence">{p.connected?"●":"○"}</span></div>)}</div>
        {me && me.id !== room.hostId && <button className="primary wide" onClick={ready}>{me.ready?"I'm not ready":"I'm ready"}</button>}
        {isHost && <button className="primary wide" disabled={room.players.length<2 || room.players.some(p=>!p.ready && p.id!==room.hostId)} onClick={start}>Start game →</button>}
        {isHost && <p className="tiny">You are the host. Everyone must be ready before you start.</p>}
        {notice && <div className="notice">{notice}</div>}
      </div>}

      {screen === "game" && room && <div className="game-layout">
        <div className="game-top"><div><span className="eyebrow">ROUND {Math.floor(room.turnIndex / room.players.length)+1} OF {room.totalRounds}</span><h2>{isPerformer?"Your turn to perform!":"Time to guess!"}</h2></div><div className={`timer ${seconds<=10?"urgent":""}`}><strong>{seconds}</strong><span>SECONDS</span></div></div>
        <div className="turn-banner"><span>{room.players.find(p=>p.id===room.turn?.performerId)?.avatar}</span><div><b>{isPerformer?"You are performing":`${room.players.find(p=>p.id===room.turn?.performerId)?.name || "A player"} is performing`}</b><small>{room.turn?.mode==="act"?"🎭 Act it out":"✏️ Draw it"} · {room.turn?.category}</small></div><span className="mode-pill">{room.turn?.mode?.toUpperCase()}</span></div>
        {isPerformer && <div className="secret-card"><span>YOUR SECRET PROMPT</span><strong>{prompt?.answer || "Loading your prompt…"}</strong><small>Keep it secret! Your friends must guess.</small></div>}
        {room.turn?.mode==="draw" && <CanvasBoard enabled={isPerformer} onStroke={sendStroke} onClear={clearDrawing} remoteVersion={remoteStroke} />}
        {room.turn?.mode==="act" && <div className="act-stage"><div className="act-emoji">🎬</div><b>{isPerformer?"Act without speaking!":"Watch closely and guess!"}</b><p>{isPerformer?"Use gestures and body movements. No words or sounds.":"Submit your guess below as soon as you know it."}</p></div>}
        {isPerformer ? <div className="performer-controls"><button className="secondary" onClick={pass} disabled={(room.turn?.passesLeft||0)<=0}>Pass word ({room.turn?.passesLeft||0} left)</button><span>Keep the clues coming!</span></div> :
          <form className="guess-form" onSubmit={submitGuess}><input value={guess} onChange={e=>setGuess(e.target.value)} disabled={alreadyGuessed || seconds===0} maxLength={80} placeholder={alreadyGuessed?"You got it!":"Type your guess…"} /><button className="primary" disabled={alreadyGuessed || seconds===0 || !guess.trim()}>Guess</button></form>}
        {lastCorrect && <div className="notice success">{lastCorrect}</div>}
        {notice && <div className="notice">{notice}</div>}
        <div className="score-strip">{sortedPlayers.map(p=><div className="score-chip" key={p.id}><span>{p.avatar}</span><b>{p.name}</b><strong>{p.score}</strong></div>)}</div>
        {answerReveal && <div className="overlay"><div className="result-pop"><span className="eyebrow">TURN COMPLETE</span><h2>{answerReveal.answer}</h2><p>{answerReveal.correctPlayerIds.length ? `${answerReveal.correctPlayerIds.length} player(s) guessed correctly!` : "Nobody guessed it this time."}</p></div></div>}
      </div>}

      {screen === "results" && room && <div className="panel results">
        <div className="eyebrow">SHOWDOWN COMPLETE</div><div className="trophy">🏆</div><h1>And the winner is…</h1>
        <h2>{leaderboard[0]?.name || sortedPlayers[0]?.name || "Champion"}!</h2>
        <div className="leaderboard">{(leaderboard.length?leaderboard:sortedPlayers).map((p,i)=><div className={`leader-row ${i===0?"winner":""}`} key={p.id}><span className="rank">{i===0?"👑":i+1}</span><span>{p.avatar}</span><b>{p.name}</b><span className="points">{p.score} pts</span></div>)}</div>
        <p className="tiny">Tie-breakers: most correct guesses, then most first guesses. Exact ties share the win.</p>
        <button className="primary wide" onClick={()=>{setScreen("home");setRoom(null);setPrompt(null);setNotice("");setLeaderboard([]);}}>Back to home</button>
      </div>}
    </section>
    <footer>CHARADES SHOWDOWN <span>•</span> MAKE SOME MEMORIES</footer>
  </main>;
}
