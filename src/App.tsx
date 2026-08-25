import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  CircleStop,
  Command,
  FilePenLine,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  MessageSquareText,
  RefreshCw,
  Search,
  Send,
  Server,
  ShieldQuestion,
  Smartphone,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BridgeClient, upsertRequest } from "./bridge";
import { activeTurnId, applyThreadEvent } from "./thread-state";
import type { BridgeMessage, CodexThread, RpcEvent, ThreadPage, ThreadResumeResponse } from "./types";

const bridge = new BridgeClient();

interface SessionState {
  loading: boolean;
  authRequired: boolean;
  authenticated: boolean;
}

async function readSession(): Promise<SessionState> {
  const response = await fetch("/api/session");
  const data = await response.json();
  return { loading: false, ...data };
}

function formatWhen(timestamp: number) {
  const date = new Date(timestamp * 1000);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function statusText(thread: CodexThread) {
  if (thread.status.type === "active") {
    if (thread.status.activeFlags?.includes("waitingOnApproval")) return "等待批准";
    if (thread.status.activeFlags?.includes("waitingOnUserInput")) return "等你回复";
    return "运行中";
  }
  if (thread.status.type === "systemError") return "异常";
  return "空闲";
}

function sourceText(source: CodexThread["source"]) {
  if (typeof source === "string") return source === "vscode" ? "Codex Desktop" : source;
  return "Codex";
}

function titleFor(thread: CodexThread) {
  return thread.name?.trim() || thread.preview.trim().split("\n")[0] || "未命名线程";
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "登录失败");
      onAuthenticated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark"><Smartphone size={25} /><span /><Server size={25} /></div>
        <p className="eyebrow">你的电脑</p>
        <h1>继续使用 Codex</h1>
        <p className="muted">手机只负责交互，任务仍在电脑上运行。</p>
        <form onSubmit={submit}>
          <label htmlFor="password">访问密码</label>
          <div className="password-field">
            <LockKeyhole size={18} />
            <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus />
          </div>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button" disabled={busy || !password}>
            {busy ? <LoaderCircle className="spin" size={18} /> : "连接电脑"}
          </button>
        </form>
      </section>
    </main>
  );
}

function ThreadList({
  threads,
  loading,
  search,
  connection,
  error,
  onSearch,
  onRefresh,
  onOpen,
  onLogout,
}: {
  threads: CodexThread[];
  loading: boolean;
  search: string;
  connection: string;
  error: string;
  onSearch: (value: string) => void;
  onRefresh: () => void;
  onOpen: (thread: CodexThread) => void;
  onLogout: () => void;
}) {
  return (
    <main className="app-shell thread-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Codex Remote</p>
          <h1>电脑上的线程</h1>
        </div>
        <button className="icon-button" aria-label="退出" onClick={onLogout}><LogOut size={20} /></button>
      </header>

      <div className="connection-row">
        <span className={`connection-dot ${connection}`} />
        {connection === "connected" ? "电脑已连接" : connection === "connecting" ? "正在连接电脑" : "连接已断开，正在重试"}
      </div>

      <section className="search-row">
        <Search size={19} />
        <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索线程" />
        <button className="plain-icon" onClick={onRefresh} aria-label="刷新"><RefreshCw size={18} className={loading ? "spin" : ""} /></button>
      </section>

      {error && <div className="error-banner">{error}</div>}

      <section className="thread-list" aria-live="polite">
        {loading && !threads.length && <div className="center-state"><LoaderCircle className="spin" /><p>正在读取电脑上的线程</p></div>}
        {!loading && !threads.length && <div className="center-state"><MessageSquareText /><p>没有找到线程</p></div>}
        {threads.map((thread) => (
          <button className="thread-card" key={thread.id} onClick={() => onOpen(thread)}>
            <div className="thread-card-main">
              <h2>{titleFor(thread)}</h2>
              <p>{thread.preview}</p>
              <div className="thread-meta">
                <span>{sourceText(thread.source)}</span>
                <span>{thread.cwd}</span>
              </div>
            </div>
            <div className="thread-card-side">
              <time>{formatWhen(thread.updatedAt)}</time>
              <span className={`status-badge ${thread.status.type}`}>{statusText(thread)}</span>
            </div>
          </button>
        ))}
      </section>
    </main>
  );
}

function Conversation({ thread }: { thread: CodexThread }) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [thread.turns]);

  return (
    <div className="conversation">
      {thread.turns.flatMap((turn) => turn.items.map((item, index) => {
        if (item.type === "reasoning" || item.type === "plan") return null;
        if (item.type === "userMessage") {
          const text = item.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
          return <div className="message-row user" key={item.id ?? `${turn.id}-${index}`}><div className="message-bubble">{text}</div></div>;
        }
        if (item.type === "agentMessage" && item.text) {
          return (
            <div className="message-row agent" key={item.id ?? `${turn.id}-${index}`}>
              <div className="agent-label">Codex</div>
              <div className="message-bubble markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown></div>
            </div>
          );
        }
        // 手机端只显示对话；命令、文件变化、推理和工具过程都留在电脑端。
        return null;
      }))}
      {activeTurnId(thread) && <div className="thinking"><LoaderCircle className="spin" size={16} /> Codex 正在电脑上处理</div>}
      <div ref={bottom} />
    </div>
  );
}

function ApprovalCard({ request, onResolve }: { request: RpcEvent; onResolve: (request: RpcEvent, result: unknown) => void }) {
  const params = request.params ?? {};
  const isCommand = request.method.includes("commandExecution") || request.method === "execCommandApproval";
  const isFile = request.method.includes("fileChange") || request.method === "applyPatchApproval";
  const isQuestion = request.method === "item/tool/requestUserInput";
  const Icon = isCommand ? Command : isFile ? FilePenLine : ShieldQuestion;

  if (isQuestion) {
    const questions = (params.questions ?? []) as Array<{ id: string; header: string; question: string; options?: Array<{ label: string; description?: string }> | null }>;
    return (
      <section className="approval-card">
        <div className="approval-heading"><Icon size={20} /><strong>Codex 需要你回答</strong></div>
        {questions.map((question) => (
          <div className="question" key={question.id}>
            <p>{question.question}</p>
            <div className="choice-grid">
              {question.options?.map((option) => (
                <button key={option.label} onClick={() => onResolve(request, { answers: { [question.id]: { answers: [option.label] } } })}>
                  <strong>{option.label}</strong>{option.description && <small>{option.description}</small>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>
    );
  }

  const description = String(params.command ?? params.reason ?? (isFile ? "允许 Codex 修改文件" : "允许 Codex 继续这项操作"));
  const acceptResult = request.method.includes("permissions")
    ? { permissions: params.permissions ?? {}, scope: "session" }
    : { decision: "accept" };
  const sessionResult = request.method.includes("permissions")
    ? acceptResult
    : { decision: "acceptForSession" };
  const declineResult = request.method.includes("permissions")
    ? { permissions: {}, scope: "turn" }
    : { decision: "decline" };

  return (
    <section className="approval-card">
      <div className="approval-heading"><Icon size={20} /><strong>{isCommand ? "请求运行命令" : isFile ? "请求修改文件" : "请求额外权限"}</strong></div>
      <pre className="approval-description">{description}</pre>
      <div className="approval-actions">
        <button className="deny" onClick={() => onResolve(request, declineResult)}><X size={17} />拒绝</button>
        <button onClick={() => onResolve(request, sessionResult)}>本次会话允许</button>
        <button className="allow" onClick={() => onResolve(request, acceptResult)}><Check size={17} />允许一次</button>
      </div>
    </section>
  );
}

function ChatView({
  response,
  requests,
  sending,
  error,
  onBack,
  onSend,
  onStop,
  onResolve,
}: {
  response: ThreadResumeResponse;
  requests: RpcEvent[];
  sending: boolean;
  error: string;
  onBack: () => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onResolve: (request: RpcEvent, result: unknown) => void;
}) {
  const [text, setText] = useState("");
  const running = Boolean(activeTurnId(response.thread));
  const readOnly = response.access === "readOnly";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending || readOnly) return;
    onSend(text);
    setText("");
  };

  return (
    <main className="chat-shell">
      <header className="chat-header">
        <button className="icon-button" onClick={onBack} aria-label="返回"><ArrowLeft size={22} /></button>
        <div>
          <h1>{titleFor(response.thread)}</h1>
          <p>{response.model} · {response.cwd}</p>
        </div>
        {readOnly ? <span className="idle-mark live-sync"><span />完成后同步</span> : running ? <button className="stop-button" onClick={onStop}><CircleStop size={18} />停止</button> : <span className="idle-mark">空闲</span>}
      </header>

      <Conversation thread={response.thread} />
      {response.notice && <div className="read-only-banner">{response.notice}</div>}
      {error && <div className="chat-error">{error}</div>}
      {requests.map((request) => <ApprovalCard key={String(request.id)} request={request} onResolve={onResolve} />)}

      <form className="composer" onSubmit={submit}>
        <textarea disabled={readOnly} value={text} onChange={(event) => setText(event.target.value)} placeholder={readOnly ? "电脑端正在使用此任务" : running ? "继续补充指令…" : "给 Codex 发消息…"} rows={1} />
        <button disabled={readOnly || !text.trim() || sending} aria-label="发送">{sending ? <LoaderCircle className="spin" size={20} /> : <Send size={20} />}</button>
      </form>
    </main>
  );
}

export default function App() {
  const [session, setSession] = useState<SessionState>({ loading: true, authRequired: false, authenticated: false });
  const [connection, setConnection] = useState("connecting");
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState<ThreadResumeResponse | null>(null);
  const [requests, setRequests] = useState<RpcEvent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => { void readSession().then(setSession).catch((reason) => setError(String(reason))); }, []);

  const loadThreads = useCallback(async (term = "") => {
    setLoading(true);
    setError("");
    try {
      const page = await bridge.request<ThreadPage>("threads:list", { searchTerm: term });
      setThreads(page.data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!session.authenticated) return;
    bridge.connect();
    const offState = bridge.onState(setConnection);
    const offMessage = bridge.onMessage((message: BridgeMessage) => {
      if (message.type === "ready") {
        setRequests(message.pendingRequests);
        void loadThreads("");
      } else if (message.type === "serverRequest") {
        setRequests((current) => upsertRequest(current, message.request));
      } else if (message.type === "event") {
        setSelected((current) => current ? { ...current, thread: applyThreadEvent(current.thread, message.method, message.params ?? {}) } : current);
        if (message.method === "serverRequest/resolved") {
          const requestId = message.params?.requestId;
          setRequests((current) => current.filter((request) => request.id !== requestId));
        }
      }
    });
    return () => { offState(); offMessage(); bridge.disconnect(); };
  }, [session.authenticated, loadThreads]);

  useEffect(() => {
    if (!session.authenticated) return;
    const timer = window.setTimeout(() => void loadThreads(search), 300);
    return () => window.clearTimeout(timer);
  }, [search, session.authenticated, loadThreads]);

  useEffect(() => {
    const threadId = selected?.thread.id;
    if (!session.authenticated || selected?.access !== "readOnly" || !threadId) return;

    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const result = await bridge.request<{ thread: CodexThread }>("thread:read", { threadId });
        if (disposed) return;
        setSelected((current) => {
          if (!current || current.thread.id !== threadId) return current;
          const previousTurn = current.thread.turns.at(-1);
          const nextTurn = result.thread.turns.at(-1);
          if (current.thread.updatedAt === result.thread.updatedAt && JSON.stringify(previousTurn) === JSON.stringify(nextTurn)) return current;
          return { ...current, thread: result.thread };
        });
      } catch {
        // The WebSocket reconnect loop handles temporary network loss.
      } finally {
        refreshing = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [session.authenticated, selected?.access, selected?.thread.id]);

  async function openThread(thread: CodexThread) {
    setOpening(true);
    setError("");
    try {
      const response = await bridge.request<ThreadResumeResponse>("thread:open", { threadId: thread.id });
      setSelected(response);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpening(false);
    }
  }

  async function sendMessage(text: string) {
    if (!selected) return;
    setSending(true);
    setError("");
    try {
      await bridge.request("turn:start", { threadId: selected.thread.id, text });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  }

  async function stopTurn() {
    const turnId = activeTurnId(selected?.thread ?? null);
    if (!selected || !turnId) return;
    try {
      await bridge.request("turn:interrupt", { threadId: selected.thread.id, turnId });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function resolveRequest(request: RpcEvent, result: unknown) {
    try {
      await bridge.request("server-request:respond", { serverRequestId: request.id, result });
      setRequests((current) => current.filter((item) => item.id !== request.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function logout() {
    await fetch("/api/session", { method: "DELETE" });
    bridge.disconnect();
    setSession((current) => ({ ...current, authenticated: false }));
  }

  const threadRequests = useMemo(
    () => selected ? requests.filter((request) => request.params?.threadId === selected.thread.id) : [],
    [requests, selected],
  );

  if (session.loading) return <div className="full-loader"><LoaderCircle className="spin" /><p>正在连接</p></div>;
  if (!session.authenticated) return <LoginScreen onAuthenticated={() => setSession((current) => ({ ...current, authenticated: true }))} />;
  if (opening) return <div className="full-loader"><LoaderCircle className="spin" /><p>正在接入线程</p></div>;
  if (selected) return <ChatView response={selected} requests={threadRequests} sending={sending} error={error} onBack={() => { setSelected(null); void loadThreads(search); }} onSend={sendMessage} onStop={stopTurn} onResolve={resolveRequest} />;
  return <ThreadList threads={threads} loading={loading} search={search} connection={connection} error={error} onSearch={setSearch} onRefresh={() => void loadThreads()} onOpen={openThread} onLogout={logout} />;
}
