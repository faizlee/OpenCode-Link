import { FormEvent, useCallback, useEffect, useState } from "react";
import { loadOverview } from "./api";
import { formatDeviceWhen, isUnusedDevice } from "./devices";
import { consolePath, consoleSection, type ConsoleSection } from "../navigation";
import "./redline.css";

interface RuntimeState {
  ok?: boolean;
  productId?: string;
  version?: string;
  buildId?: string;
  instanceId?: string;
  installRoot?: string;
  dataRoot?: string;
  port?: number;
  startedAt?: string;
  servicePid?: number;
  appServer?: string;
  tray?: { version?: string; buildId?: string; installRoot?: string } | null;
}

interface ConnectionState {
  stableName?: string | null;
  stableOrigin?: string | null;
  stableAvailable?: boolean;
  recommendedOrigin?: string | null;
  defaultPortRedirect?: boolean;
  appPort?: number;
  usingIpFallback?: boolean;
  lanAddresses?: Array<{ name: string; address: string; origin: string }>;
  tailscaleAddresses?: Array<{ name: string; address: string; origin: string; tailscale: true }>;
}

interface ConsoleDevice {
  id: string;
  name: string;
  kind?: string;
  createdAt: number;
  lastSeenAt: number;
  remoteAddress: string;
  current?: boolean;
}

interface PairingAddress {
  name: string;
  address: string;
  origin: string;
  url: string;
  qr: string;
  stable?: boolean;
  tailscale?: boolean;
}

interface PairingState {
  expiresAt: number;
  primary: PairingAddress;
  addresses: Array<Omit<PairingAddress, "url" | "qr">>;
}

interface SettingsState {
  autoStart?: boolean;
  openConsoleOnStart?: boolean;
  keepRunningWhenBrowserCloses?: boolean;
  dataRoot?: string;
  uploadDir?: string;
  logDir?: string;
}

const SECTIONS: Array<{ id: ConsoleSection; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "devices", label: "设备" },
  { id: "connection", label: "连接" },
  { id: "settings", label: "设置" },
  { id: "about", label: "关于" },
];

function statusLabel(ok: boolean, runningText: string, stoppedText: string) {
  return ok ? runningText : stoppedText;
}

export default function ConsoleApp() {
  const [section, setSection] = useState<ConsoleSection>(() => consoleSection(window.location.pathname) ?? "overview");
  const [health, setHealth] = useState<RuntimeState>({});
  const [runtime, setRuntime] = useState<RuntimeState>({});
  const [connection, setConnection] = useState<ConnectionState>({});
  const [devices, setDevices] = useState<ConsoleDevice[]>([]);
  const [settings, setSettings] = useState<SettingsState>({});
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const snapshot = await loadOverview();
      setHealth(snapshot.health as RuntimeState);
      setRuntime(snapshot.runtime as RuntimeState);
      setConnection(snapshot.connection as ConnectionState);
      setDevices(snapshot.devices as ConsoleDevice[]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const response = await fetch("/api/settings", { cache: "no-store" });
    const data = await response.json() as SettingsState & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "无法读取设置");
    setSettings(data);
  }, []);

  useEffect(() => {
    document.body.classList.add("console-active");
    void load();
    return () => document.body.classList.remove("console-active");
  }, [load]);

  useEffect(() => {
    if (section === "settings" || section === "about") void loadSettings().catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [section, loadSettings]);

  useEffect(() => {
    const onPop = () => setSection(consoleSection(window.location.pathname) ?? "overview");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!pairing) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  function go(next: ConsoleSection) {
    window.history.pushState({ view: "console", section: next }, "", consolePath(next));
    setSection(next);
  }

  async function copyOrigin() {
    if (!connection.recommendedOrigin) return;
    await navigator.clipboard.writeText(connection.recommendedOrigin);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function issuePairing() {
    setPairingOpen(true);
    setPairingLoading(true);
    setError("");
    try {
      const response = await fetch("/api/pairing", { method: "POST", cache: "no-store" });
      const data = await response.json() as PairingState & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "无法生成二维码");
      setPairing(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPairingLoading(false);
    }
  }

  useEffect(() => {
    if (window.location.hash === "#add-phone") void issuePairing();
  }, []);

  async function renameDevice(device: ConsoleDevice, event: FormEvent) {
    event.preventDefault();
    const name = (renaming[device.id] ?? device.name).trim();
    setBusyId(device.id);
    setError("");
    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(device.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "改名失败");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId("");
    }
  }

  async function revokeOne(device: ConsoleDevice) {
    if (!window.confirm(`解除“${device.name}”的访问权限？这台设备下次需要重新扫码。`)) return;
    setBusyId(device.id);
    setError("");
    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "解除设备失败");
      setSelected((current) => {
        const next = new Set(current);
        next.delete(device.id);
        return next;
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId("");
    }
  }

  async function revokeSelected() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(`解除已勾选的 ${ids.length} 台设备？它们下次需要重新扫码。`)) return;
    setBusyId("batch");
    setError("");
    try {
      const response = await fetch("/api/devices/revoke-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "批量解除失败");
      setSelected(new Set());
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId("");
    }
  }

  const remainingMs = pairing ? pairing.expiresAt - now : 0;
  const primaryQr = pairing?.primary;
  const versionMismatch = Boolean(runtime.tray?.version && runtime.version && runtime.tray.version !== runtime.version);
  const recentDevices = devices.filter((device) => !isUnusedDevice(device.lastSeenAt)).slice(0, 3);
  const unusedDevices = devices.filter((device) => isUnusedDevice(device.lastSeenAt));
  const activeDevices = devices.filter((device) => !isUnusedDevice(device.lastSeenAt));
  const serviceRunning = health.ok === true;
  const codexReady = health.appServer === "ready";

  function deviceRows(list: ConsoleDevice[]) {
    return list.map((device) => (
    <article className="console-device" key={device.id}>
      <input
        type="checkbox"
        checked={selected.has(device.id)}
        onChange={() => setSelected((current) => {
          const next = new Set(current);
          if (next.has(device.id)) next.delete(device.id);
          else next.add(device.id);
          return next;
        })}
        aria-label={`选择 ${device.name}`}
      />
      <label>
        <strong>
          {device.name}
          {device.current ? <span className="console-badge">当前设备</span> : null}
        </strong>
        <small>{device.kind ?? "已配对设备"} · 最近使用 {formatDeviceWhen(device.lastSeenAt)} · 首次添加 {formatDeviceWhen(device.createdAt)}</small>
      </label>
      <form className="console-device-tools" onSubmit={(event) => void renameDevice(device, event)}>
        <input
          value={renaming[device.id] ?? device.name}
          onChange={(event) => setRenaming((current) => ({ ...current, [device.id]: event.target.value }))}
          aria-label={`${device.name} 的新名称`}
        />
        <button className="console-button secondary" disabled={busyId === device.id}>改名</button>
        <button className="console-button danger" type="button" disabled={busyId === device.id} onClick={() => void revokeOne(device)}>解除设备</button>
      </form>
    </article>
    ));
  }

  const overview = (
    <section className="console-section">
      <h2>运行状态</h2>
      <dl className="console-rows">
        <div className="console-row"><dt>服务</dt><dd><span className="console-status-text"><span className={`console-status-mark ${serviceRunning ? "ok" : "warn"}`} />{statusLabel(serviceRunning, "运行中", "已停止")}</span></dd></div>
        <div className="console-row"><dt>Codex</dt><dd><span className="console-status-text"><span className={`console-status-mark ${codexReady ? "ok" : ""}`} />{codexReady ? "已连接" : "未连接"}</span></dd></div>
        <div className="console-row"><dt>版本</dt><dd>服务 {runtime.version ?? health.version ?? "未知"}{runtime.tray?.version ? ` · 托盘 ${runtime.tray.version}` : " · 托盘未接入"}</dd></div>
        <div className="console-row"><dt>设备</dt><dd>{devices.length} 台受信任设备</dd></div>
        <div className="console-row"><dt>固定地址</dt><dd>{connection.stableAvailable ? connection.stableOrigin : "当前使用 IP 备用入口"}</dd></div>
      </dl>
      {versionMismatch && (
        <div className="console-banner">
          <strong>托盘版本与服务版本不一致</strong>
          请改用托盘菜单切换到当前安装目录中的版本，网页不能自行替换服务。
        </div>
      )}
      <div className="console-actions">
        <button className="console-button" onClick={() => void issuePairing()}>添加手机</button>
        <button className="console-button secondary" onClick={() => void copyOrigin()} disabled={!connection.recommendedOrigin}>{copied ? "已复制访问地址" : "复制访问地址"}</button>
      </div>
      <h2>最近使用的设备</h2>
      {recentDevices.length === 0 ? <p className="console-empty">还没有最近使用的设备。</p> : recentDevices.map((device) => (
        <article className="console-device" key={device.id}>
          <span />
          <label>
            <strong>{device.name}</strong>
            <small>最近使用 {formatDeviceWhen(device.lastSeenAt)}</small>
          </label>
          <button className="console-button secondary" type="button" onClick={() => go("devices")}>查看全部</button>
        </article>
      ))}
    </section>
  );

  const pairingPanel = pairingOpen && (
    <section className="console-panel">
      <h2>添加手机</h2>
      {pairingLoading && <p className="console-muted">正在生成二维码</p>}
      {primaryQr && (
        <>
          <img className="console-qr" src={primaryQr.qr} alt="手机配对二维码" />
          <p className="console-muted">扫描后会绑定这台手机与电脑。局域网、固定名称和 Tailscale 等连接方式由软件自动选择，网络变化时不需要重新扫码。</p>
          <p className="console-muted">{remainingMs > 0 ? `剩余 ${Math.ceil(remainingMs / 1000)} 秒` : "二维码已过期，请刷新。"}</p>
          <div className="console-actions">
            <button className="console-button secondary" onClick={() => void issuePairing()}>刷新二维码</button>
            <button className="console-button secondary" onClick={() => { setPairingOpen(false); setPairing(null); }}>关闭</button>
          </div>
          <details className="console-fold">
            <summary>技术地址与备用入口</summary>
            <dl className="console-rows">
              {pairing?.addresses.map((address) => (
                <div className="console-row" key={address.address}>
                  <dt>{address.tailscale ? "Tailscale" : address.stable ? "固定名称" : address.name}</dt>
                  <dd>{address.origin}</dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </section>
  );

  const devicesPage = (
    <section className="console-section">
      <h2>受信任设备</h2>
      <p className="console-muted">改名只改显示名称。解除后该设备需要重新扫码。不会按名称自动合并不同设备。</p>
      <div className="console-actions">
        <button className="console-button danger" disabled={!selected.size || busyId === "batch"} onClick={() => void revokeSelected()}>解除已选设备</button>
        <button className="console-button secondary" onClick={() => void load()}>刷新</button>
      </div>
      {activeDevices.length === 0 ? <p className="console-empty">暂时没有常用设备。</p> : <div className="console-device-list">{deviceRows(activeDevices)}</div>}
      {unusedDevices.length > 0 && (
        <details className="console-fold">
          <summary>长期未使用（{unusedDevices.length}）</summary>
          <div className="console-device-list">{deviceRows(unusedDevices)}</div>
        </details>
      )}
    </section>
  );

  const connectionPage = (
    <section className="console-section">
      <h2>连接</h2>
      <dl className="console-rows">
        <div className="console-row"><dt>固定名称</dt><dd>{connection.stableAvailable ? connection.stableOrigin : "当前不可用，正在使用 IP 备用入口"}</dd></div>
        <div className="console-row"><dt>局域网地址</dt><dd>{connection.lanAddresses?.[0]?.origin ?? "未发现物理网卡地址"}</dd></div>
        <div className="console-row"><dt>Tailscale 入口</dt><dd>{connection.tailscaleAddresses?.[0]?.origin ?? "未发现正在运行的 Tailscale"}</dd></div>
        <div className="console-row"><dt>推荐入口</dt><dd>{connection.recommendedOrigin ?? "暂无"}</dd></div>
        <div className="console-row"><dt>端口</dt><dd>{connection.defaultPortRedirect ? "80 转发可用" : `回退到 ${connection.appPort ?? runtime.port ?? ""}`}</dd></div>
      </dl>
      <div className="console-actions">
        <button className="console-button secondary" onClick={() => void copyOrigin()} disabled={!connection.recommendedOrigin}>{copied ? "已复制" : "复制地址"}</button>
        <button className="console-button secondary" onClick={() => void load()}>重新检测</button>
      </div>
      <details className="console-fold">
        <summary>网卡与端口详情</summary>
        <dl className="console-rows">
          {(connection.lanAddresses ?? []).map((address) => (
            <div className="console-row" key={address.address}><dt>{address.name}</dt><dd>{address.origin}</dd></div>
          ))}
          {(connection.tailscaleAddresses ?? []).map((address) => (
            <div className="console-row" key={address.address}><dt>Tailscale</dt><dd>{address.origin}</dd></div>
          ))}
        </dl>
      </details>
    </section>
  );

  const settingsPage = (
    <section className="console-section">
      <h2>设置</h2>
      <dl className="console-rows">
        <div className="console-row"><dt>开机启动</dt><dd>{settings.autoStart ? "已启用，由托盘写入登录项" : "未启用。请在托盘菜单中更改，网页不能改服务生命周期。"}</dd></div>
        <div className="console-row"><dt>启动后打开管理台</dt><dd>{settings.openConsoleOnStart === false ? "否" : "是"}</dd></div>
        <div className="console-row"><dt>关闭浏览器</dt><dd>后台服务继续运行。停止或退出只能由托盘确认。</dd></div>
        <div className="console-row"><dt>附件清理</dt><dd>手机发来的临时附件保存在电脑用户数据目录，成功排队的副本 24 小时后自动删除。</dd></div>
      </dl>
    </section>
  );

  const aboutPage = (
    <section className="console-section">
      <h2>关于</h2>
      <dl className="console-rows">
        <div className="console-row"><dt>服务版本</dt><dd>{runtime.version ?? health.version ?? "未知"}</dd></div>
        <div className="console-row"><dt>托盘版本</dt><dd>{runtime.tray?.version || "托盘尚未接入"}</dd></div>
        <div className="console-row"><dt>buildId</dt><dd>{runtime.buildId ?? health.buildId ?? "未知"}</dd></div>
        <div className="console-row"><dt>instanceId</dt><dd>{runtime.instanceId ?? health.instanceId ?? "未知"}</dd></div>
        <div className="console-row"><dt>最近启动</dt><dd>{runtime.startedAt ? formatDeviceWhen(Date.parse(runtime.startedAt)) : "未知"}</dd></div>
        <div className="console-row"><dt>数据目录</dt><dd>{settings.dataRoot ?? runtime.dataRoot ?? "未知"}</dd></div>
        <div className="console-row"><dt>日志目录</dt><dd>{settings.logDir ?? "未知"}</dd></div>
        <div className="console-row"><dt>附件目录</dt><dd>{settings.uploadDir ?? "未知"}</dd></div>
      </dl>
    </section>
  );

  const body = section === "devices"
    ? devicesPage
    : section === "connection"
      ? connectionPage
      : section === "settings"
        ? settingsPage
        : section === "about"
          ? aboutPage
          : overview;

  return (
    <main className="console-root">
      <div className="console-frame">
        <header className="console-header">
          <div>
            <p className="console-kicker">OpenCodex Link</p>
            <h1>电脑管理台</h1>
          </div>
          <p className="console-status-text">
            <span className={`console-status-mark ${serviceRunning ? "ok" : "warn"}`} />
            {statusLabel(serviceRunning, "运行中", "已停止")}
            <span aria-hidden="true">·</span>
            {runtime.version ?? health.version ?? ""}
          </p>
        </header>
        <nav className="console-nav" aria-label="管理台分区">
          {SECTIONS.map((item) => (
            <button key={item.id} className={section === item.id ? "active" : ""} onClick={() => go(item.id)}>{item.label}</button>
          ))}
        </nav>
        {error && <div className="console-error"><strong>出错</strong>{error}</div>}
        {body}
        {section === "overview" ? pairingPanel : null}
      </div>
    </main>
  );
}
