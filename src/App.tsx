import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  CircleStop,
  Command,
  FilePenLine,
  FileText,
  ImagePlus,
  Download,
  LoaderCircle,
  LogOut,
  MessageSquareText,
  Paperclip,
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
import ConsoleApp from "./console/ConsoleApp";
import { isDesktopConsolePath, listPath, threadIdFromPath, threadPath } from "./navigation";
import {
  clearRouteState,
  credentialFromHash,
  isStableHost,
  isTailscaleHost,
  loadRouteState,
  probeRouteOrigin,
  routeHash,
  saveRouteState,
  type RouteLink,
  type RouteState,
} from "./route-failover";
import { activeTurnId, applyThreadEvent } from "./thread-state";
import type { BridgeMessage, CodexThread, RpcEvent, ThreadPage, ThreadResumeResponse } from "./types";

const bridge = new BridgeClient();

interface SessionState {
  loading: boolean;
  authRequired: boolean;
  authenticated: boolean;
  pairingOnly?: boolean;
}

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

interface PendingAttachment {
  id: string;
  file: File;
  preview: string | null;
}

const MAX_ATTACHMENT_COUNT = 20;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_BATCH_BYTES = 200 * 1024 * 1024;

const SHORTCUT_READY_KEY = "opencodexlink-shortcut-ready-v2";

async function readSession(): Promise<SessionState> {
  const hashCredential = credentialFromHash(window.location.hash);
  const saved = loadRouteState();
  const credential = hashCredential || saved?.credential || "";
  let response = await fetch("/api/session", { cache: "no-store" });
  let data = await response.json() as SessionState;

  if ((hashCredential || !data.authenticated) && credential) {
    const adopted = await fetch("/api/session/adopt-route", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential }),
    });
    if (adopted.ok) {
      saveRouteState(credential, saved?.links ?? []);
      response = await fetch("/api/session", { cache: "no-store" });
      data = await response.json() as SessionState;
    }
  } else if (data.authenticated && credential) {
    saveRouteState(credential, saved?.links ?? []);
  }

  if (hashCredential && data.authenticated) {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }
  return { ...data, loading: false };
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

function PairingRequiredScreen() {
  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-mark"><Smartphone size={25} /><span /><Server size={25} /></div>
        <p className="eyebrow">等待设备配对</p>
        <h1>请扫描电脑上的二维码</h1>
        <p className="muted">在电脑托盘打开 OpenCodex Link，点击“添加手机”并扫码。配对完成后，这台设备以后直接打开即可，不再需要密码。</p>
      </section>
    </main>
  );
}

function InstallShortcut() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const secureContext = window.isSecureContext;
  const [hidden, setHidden] = useState(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches
      || Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
    return standalone || window.localStorage.getItem(SHORTCUT_READY_KEY) === "1";
  });

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      window.localStorage.setItem(SHORTCUT_READY_KEY, "1");
      setHidden(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (hidden) return null;

  async function install() {
    if (!prompt) {
      setShowHelp(true);
      return;
    }
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") {
      window.localStorage.setItem(SHORTCUT_READY_KEY, "1");
      setHidden(true);
    }
    setPrompt(null);
  }

  function markReady() {
    window.localStorage.setItem(SHORTCUT_READY_KEY, "1");
    setHidden(true);
  }

  return (
    <section className="install-shortcut">
      <Download size={21} />
      <div>
        <strong>{secureContext ? "安装到手机" : "添加到手机桌面"}</strong>
        <p>{showHelp
          ? secureContext
            ? "打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。"
            : "当前局域网地址只能创建网页快捷方式。若 Chrome 菜单点了没反应，请到手机设置里允许 Chrome“创建桌面快捷方式”，再添加一次。"
          : "第一次添加后，以后点桌面图标就能直接进入，不需要重新扫码。"}</p>
        {showHelp && <button className="install-done" onClick={markReady}>暂时隐藏</button>}
      </div>
      {!showHelp && <button onClick={() => void install()}>{prompt ? "安装" : "查看方法"}</button>}
    </section>
  );
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 3_000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function PreferredAddressAdopter({ authenticated, connection }: { authenticated: boolean; connection: string }) {
  useEffect(() => {
    if (!authenticated) return;
    let disposed = false;
    let running = false;
    let cachedState: RouteState | null = loadRouteState();

    const adopt = async () => {
      if (disposed || running) return;
      running = true;
      let currentOriginReachable = false;
      try {
        try {
          const response = await fetchWithTimeout("/api/preferred-links", { method: "POST", cache: "no-store" });
          if (response.ok) {
            const data = await response.json() as { credential?: string; links?: RouteLink[] };
            if (data.credential && Array.isArray(data.links)) {
              cachedState = saveRouteState(data.credential, data.links);
              currentOriginReachable = true;
            }
          }
        } catch {
          // The current address may have disappeared. Cached candidates remain
          // usable because the route credential is device-bound, not origin-bound.
        }

        if (!cachedState || disposed) return;
        const currentIsTailscale = isTailscaleHost(window.location.hostname);
        if (currentOriginReachable && currentIsTailscale) return;

        const currentIsStable = isStableHost(window.location.hostname);
        const candidates = cachedState.links.filter((link) => {
          if (link.origin === window.location.origin) return false;
          if (!currentOriginReachable) return true;
          if (link.tailscale) return true;
          return !currentIsStable && link.stable === true;
        });

        for (const link of candidates) {
          try {
            if (!await probeRouteOrigin(link.origin)) continue;
            const destination = new URL(`${window.location.pathname}${window.location.search}`, link.origin);
            destination.hash = routeHash(cachedState.credential).slice(1);
            window.location.replace(destination.toString());
            return;
          } catch {
            // Try the next known route. A network path can become available
            // after this page was opened, so the interval below keeps retrying.
          }
        }
      } finally {
        running = false;
      }
    };

    void adopt();
    const timer = window.setInterval(() => void adopt(), 8_000);
    const onOnline = () => void adopt();
    const onVisible = () => {
      if (document.visibilityState === "visible") void adopt();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authenticated, connection]);
  return null;
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
          <p className="eyebrow">OpenCodex Link</p>
          <h1>电脑上的任务</h1>
        </div>
        <button className="icon-button" aria-label="退出" onClick={onLogout}><LogOut size={20} /></button>
      </header>

      <div className="connection-row">
        <span className={`connection-dot ${connection}`} />
        {connection === "connected" ? "电脑已连接" : connection === "connecting" ? "正在连接电脑" : "连接已断开，正在重试"}
      </div>

      <InstallShortcut />

      <section className="search-row">
        <Search size={19} />
        <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="搜索任务" />
        {search && <button className="plain-icon" onClick={() => onSearch("")} aria-label="清空搜索"><X size={17} /></button>}
        <button className="plain-icon" onClick={onRefresh} aria-label="刷新"><RefreshCw size={18} className={loading ? "spin" : ""} /></button>
      </section>

      {error && <div className="error-banner">{error}</div>}

      <section className="thread-list" aria-live="polite">
        {loading && !threads.length && <div className="center-state"><LoaderCircle className="spin" /><p>正在读取电脑上的线程</p></div>}
        {!loading && !threads.length && <div className="center-state"><MessageSquareText /><p>没有找到任务</p></div>}
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
  const container = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const updateStickiness = () => {
      stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 160;
    };
    element.addEventListener("scroll", updateStickiness, { passive: true });
    window.requestAnimationFrame(() => { element.scrollTop = element.scrollHeight; });
    return () => element.removeEventListener("scroll", updateStickiness);
  }, []);

  useEffect(() => {
    const element = container.current;
    if (stickToBottom.current && element) element.scrollTop = element.scrollHeight;
  }, [thread.turns]);

  return (
    <div ref={container} className="conversation">
      {thread.turns.flatMap((turn) => turn.items.map((item, index) => {
        if (item.type === "reasoning" || item.type === "plan") return null;
        if (item.type === "userMessage") {
          const text = item.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
          const imageCount = item.content?.filter((part) => part.type === "image" || part.type === "localImage").length ?? 0;
          return (
            <div className="message-row user" key={item.id ?? `${turn.id}-${index}`}>
              <div className="message-bubble">
                {text && <div>{text}</div>}
                {imageCount > 0 && <div className="sent-image-count"><ImagePlus size={15} />{imageCount} 张图片</div>}
              </div>
            </div>
          );
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
      {activeTurnId(thread) && <div className="thinking"><LoaderCircle className="spin" size={16} /> Codex 正在处理，回复会自动出现</div>}
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
  connection,
  error,
  deliveryNotice,
  onBack,
  onSend,
  onStop,
  onResolve,
}: {
  response: ThreadResumeResponse;
  requests: RpcEvent[];
  sending: boolean;
  connection: string;
  error: string;
  deliveryNotice: string;
  onBack: () => void;
  onSend: (text: string, attachments: File[]) => Promise<boolean>;
  onStop: () => void;
  onResolve: (request: RpcEvent, result: unknown) => void;
}) {
  const draftKey = `codex-pwa-draft:${response.thread.id}`;
  const [text, setText] = useState(() => window.sessionStorage.getItem(draftKey) ?? "");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const attachmentInput = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const approvals = useRef<HTMLDivElement>(null);
  const running = Boolean(activeTurnId(response.thread));
  const queued = response.access === "queued";
  const connected = connection === "connected";
  useEffect(() => {
    if (text) window.sessionStorage.setItem(draftKey, text);
    else window.sessionStorage.removeItem(draftKey);
  }, [draftKey, text]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) {
      if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    }
  }, []);

  useEffect(() => {
    if (requests.length) window.requestAnimationFrame(() => approvals.current?.scrollIntoView({ block: "nearest" }));
  }, [requests.length]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if ((!text.trim() && !attachments.length) || sending || !connected) return;
    if (await onSend(text, attachments.map((attachment) => attachment.file))) {
      setText("");
      for (const attachment of attachments) {
        if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      }
      setAttachments([]);
      setAttachmentError("");
      if (attachmentInput.current) attachmentInput.current.value = "";
    }
  };

  const addAttachments = (files: FileList | null) => {
    if (!files?.length) return;
    setAttachmentError("");
    const selected = Array.from(files);
    const remaining = MAX_ATTACHMENT_COUNT - attachments.length;
    if (remaining <= 0) {
      setAttachmentError(`一次最多发送 ${MAX_ATTACHMENT_COUNT} 个附件`);
      return;
    }
    const accepted = selected.slice(0, remaining);
    const oversized = accepted.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    if (oversized) {
      setAttachmentError(`${oversized.name} 超过 50MB`);
      return;
    }
    const totalBytes = [...attachments.map((attachment) => attachment.file), ...accepted].reduce((total, file) => total + file.size, 0);
    if (totalBytes > MAX_BATCH_BYTES) {
      setAttachmentError("一次发送的附件总大小不能超过 200MB");
      return;
    }
    if (selected.length > remaining) setAttachmentError(`已保留前 ${remaining} 个；一次最多发送 ${MAX_ATTACHMENT_COUNT} 个附件`);
    setAttachments((current) => [...current, ...accepted.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }))]);
    if (attachmentInput.current) attachmentInput.current.value = "";
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => {
      if (attachment.id === id && attachment.preview) URL.revokeObjectURL(attachment.preview);
      return attachment.id !== id;
    }));
    setAttachmentError("");
  };

  return (
    <main className="chat-shell">
      <header className="chat-header">
        <button className="icon-button" onClick={onBack} aria-label="返回"><ArrowLeft size={22} /></button>
        <div>
          <h1>{titleFor(response.thread)}</h1>
          <p>{response.model} · 已同步至 {new Date(response.thread.updatedAt * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · {response.cwd}</p>
        </div>
        {!connected ? <span className="connection-mark">正在重连</span> : queued ? <span className="idle-mark live-sync"><span />电脑端任务</span> : requests.length ? <span className="approval-mark">等待确认</span> : running ? <button className="stop-button" onClick={onStop}><CircleStop size={18} />停止</button> : <span className="idle-mark">空闲</span>}
      </header>

      <Conversation thread={response.thread} />
      <div className="chat-status-stack">
        {response.notice && <div className="read-only-banner">{response.notice}</div>}
        {deliveryNotice && <div className="read-only-banner">{deliveryNotice}</div>}
        {!connected && <div className="chat-error">电脑连接已断开，正在自动重连。</div>}
        {error && <div className="chat-error">{error}</div>}
        <div ref={approvals} className="approval-stack">
          {requests.map((request) => <ApprovalCard key={String(request.id)} request={request} onResolve={onResolve} />)}
        </div>
      </div>

      <form className="composer" onSubmit={submit}>
        {attachments.length > 0 && (
          <div className="attachment-preview" aria-label={`已选择 ${attachments.length} 个附件`}>
            {attachments.map((attachment) => (
              <div className={`attachment-thumb ${attachment.preview ? "image" : "file"}`} key={attachment.id}>
                {attachment.preview
                  ? <img src={attachment.preview} alt={attachment.file.name} />
                  : <div className="attachment-file"><FileText size={22} /><span>{attachment.file.name}</span></div>}
                <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`移除 ${attachment.file.name}`}><X size={14} /></button>
              </div>
            ))}
          </div>
        )}
        {attachmentError && <div className="attachment-error">{attachmentError}</div>}
        <div className="composer-row">
          <input ref={attachmentInput} className="attachment-input" type="file" multiple disabled={!connected || sending} onChange={(event) => addAttachments(event.target.files)} />
          <button className="attachment-button" type="button" disabled={!connected || sending} onClick={() => attachmentInput.current?.click()} aria-label="选择附件"><Paperclip size={21} /></button>
          <textarea disabled={!connected || sending} value={text} onChange={(event) => setText(event.target.value)} placeholder={!connected ? "正在重新连接电脑…" : attachments.length ? `已选择 ${attachments.length} 个附件，可补充说明…` : queued ? "发消息到这个电脑任务…" : running ? "继续补充指令…" : "给 Codex 发消息…"} rows={1} />
          <button className="send-button" disabled={!connected || (!text.trim() && !attachments.length) || sending} aria-label="发送">{sending ? <LoaderCircle className="spin" size={20} /> : <Send size={20} />}</button>
        </div>
      </form>
    </main>
  );
}

export default function App() {
  const setupMode = isDesktopConsolePath(window.location.pathname);
  const [session, setSession] = useState<SessionState>({ loading: true, authRequired: false, authenticated: false });
  const [connection, setConnection] = useState("connecting");
  const [bridgeReady, setBridgeReady] = useState(false);
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get("q") ?? "");
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(() => Boolean(threadIdFromPath(window.location.pathname)));
  const [sending, setSending] = useState(false);
  const [selected, setSelected] = useState<ThreadResumeResponse | null>(null);
  const [requests, setRequests] = useState<RpcEvent[]>([]);
  const [error, setError] = useState("");
  const [deliveryNotice, setDeliveryNotice] = useState("");
  const navigationToken = useRef(0);
  const listScrollTop = useRef(0);

  useEffect(() => {
    if (!setupMode) void readSession().then(setSession).catch((reason) => setError(String(reason)));
  }, [setupMode]);

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

  const showThreadList = useCallback((scrollTop = listScrollTop.current) => {
    navigationToken.current += 1;
    listScrollTop.current = scrollTop;
    setSelected(null);
    setOpening(false);
    window.requestAnimationFrame(() => window.scrollTo({ top: scrollTop, behavior: "auto" }));
  }, []);

  const openThreadById = useCallback(async (threadId: string) => {
    const token = ++navigationToken.current;
    setOpening(true);
    setError("");
    setDeliveryNotice("");
    try {
      const response = await bridge.request<ThreadResumeResponse>("thread:open", { threadId });
      if (token !== navigationToken.current || threadIdFromPath(window.location.pathname) !== threadId) return false;
      setSelected(response);
      return true;
    } catch (reason) {
      if (token === navigationToken.current) setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      if (token === navigationToken.current) setOpening(false);
    }
  }, []);

  useEffect(() => {
    if (!session.authenticated) return;
    bridge.connect();
    const offState = bridge.onState((state) => {
      setConnection(state);
      if (state !== "connected") setBridgeReady(false);
      if (state === "unauthorized") {
        setSession((current) => ({ ...current, loading: false, authenticated: false }));
      }
    });
    const offMessage = bridge.onMessage((message: BridgeMessage) => {
      if (message.type === "ready") {
        setBridgeReady(true);
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

    const syncFromLocation = (state: Record<string, unknown> | null = window.history.state) => {
      const threadId = threadIdFromPath(window.location.pathname);
      if (threadId) {
        if (bridgeReady) void openThreadById(threadId);
        return;
      }
      setSearch(new URLSearchParams(window.location.search).get("q") ?? "");
      const scrollTop = typeof state?.listScrollTop === "number" ? state.listScrollTop : listScrollTop.current;
      showThreadList(scrollTop);
    };

    const onPopState = (event: PopStateEvent) => syncFromLocation(event.state as Record<string, unknown> | null);
    window.addEventListener("popstate", onPopState);
    syncFromLocation();
    return () => window.removeEventListener("popstate", onPopState);
  }, [bridgeReady, openThreadById, session.authenticated, showThreadList]);

  useEffect(() => {
    if (!session.authenticated) return;
    const timer = window.setTimeout(() => void loadThreads(search), 300);
    return () => window.clearTimeout(timer);
  }, [search, session.authenticated, loadThreads]);

  useEffect(() => {
    if (setupMode) return;
    if (threadIdFromPath(window.location.pathname)) return;
    window.history.replaceState({ ...(window.history.state ?? {}), view: "tasks", listScrollTop: listScrollTop.current }, "", listPath(search));
  }, [search, setupMode]);

  useEffect(() => {
    const threadId = selected?.thread.id;
    if (!session.authenticated || selected?.access === "control" || !threadId) return;

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

  function openThread(thread: CodexThread) {
    const scrollTop = window.scrollY;
    listScrollTop.current = scrollTop;
    window.history.replaceState({ ...(window.history.state ?? {}), view: "tasks", listScrollTop: scrollTop }, "", listPath(search));
    window.history.pushState({ view: "thread", threadId: thread.id, listScrollTop: scrollTop }, "", threadPath(thread.id));
    void openThreadById(thread.id);
  }

  async function sendMessage(text: string, attachments: File[]) {
    if (!selected) return false;
    setSending(true);
    setError("");
    setDeliveryNotice("");
    try {
      let result: { delivery?: string; notice?: string; attachmentCount?: number };
      if (attachments.length) {
        const body = new FormData();
        body.append("text", text);
        for (const attachment of attachments) body.append("attachments", attachment, attachment.name);
        const response = await fetch(`/api/threads/${encodeURIComponent(selected.thread.id)}/messages`, { method: "POST", body });
        const data = await response.json() as { error?: string; delivery?: string; notice?: string; attachmentCount?: number };
        if (!response.ok) throw new Error(data.error || "附件发送失败");
        result = data;
      } else {
        result = await bridge.request<{ delivery?: string; notice?: string }>("turn:start", { threadId: selected.thread.id, text });
      }
      if (result.delivery === "queued") setDeliveryNotice(result.notice ?? "消息已发送到电脑端 Codex。");
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
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
    clearRouteState();
    bridge.disconnect();
    setSession((current) => ({ ...current, authenticated: false }));
  }

  function backToList() {
    if (window.history.state?.view === "thread") {
      window.history.back();
      return;
    }
    window.history.replaceState({ view: "tasks", listScrollTop: 0 }, "", listPath(search));
    showThreadList(0);
  }

  const threadRequests = useMemo(
    () => selected ? requests.filter((request) => request.params?.threadId === selected.thread.id) : [],
    [requests, selected],
  );

  if (setupMode) return <ConsoleApp />;
  if (session.loading) return <div className="full-loader"><LoaderCircle className="spin" /><p>正在连接</p></div>;
  if (!session.authenticated) return <PairingRequiredScreen />;
  const preferredAddressAdopter = <PreferredAddressAdopter authenticated={session.authenticated} connection={connection} />;
  if (opening) return <>{preferredAddressAdopter}<div className="full-loader"><LoaderCircle className="spin" /><p>正在接入线程</p></div></>;
  if (selected) return <>{preferredAddressAdopter}<ChatView key={selected.thread.id} response={selected} requests={threadRequests} sending={sending} connection={connection} error={error} deliveryNotice={deliveryNotice} onBack={backToList} onSend={sendMessage} onStop={stopTurn} onResolve={resolveRequest} /></>;
  return <>{preferredAddressAdopter}<ThreadList threads={threads} loading={loading} search={search} connection={connection} error={error} onSearch={setSearch} onRefresh={() => void loadThreads()} onOpen={openThread} onLogout={logout} /></>;
}
