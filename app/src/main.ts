import "./style.css";
import QRCode from "qrcode";
import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  formatUnits,
  getAddress,
  hexToString,
  http,
  isAddress,
  keccak256,
  parseUnits,
  stringToHex,
  toHex,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { arcJarAbi, factoryAbi } from "./abi";
import { MEMO, USDC_ERC20, explorerAddr, explorerTx, resolveNetwork } from "./config";
import { getLang, setLang, t } from "./i18n";

// ---------------------------------------------------------------- state

const params = new URLSearchParams(location.search);
const net = resolveNetwork(params);
const pub = createPublicClient({ chain: net.chain, transport: http() });
const eth = (window as unknown as { ethereum?: { request: (a: unknown) => Promise<unknown> } }).ethereum;

let wallet: WalletClient | undefined;
let account: Address | undefined;
let watch: Address | undefined = isAddress(params.get("watch") ?? "") ? getAddress(params.get("watch")!) : undefined;
let tab: "jars" | "create" = location.hash === "#/create" ? "create" : "jars";
let toast = "";

interface JarRow {
  name: string;
  balance: bigint;
  bps: number;
  unlockAt: number;
  dest: Address;
}
interface JarView {
  address: Address;
  owner: Address;
  rows: JarRow[];
  unallocated: bigint;
}
let views: JarView[] = [];
let loading = false;

const app = document.querySelector<HTMLDivElement>("#app")!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (v: bigint) => {
  const n = Number(formatUnits(v, 18));
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: n < 1 && n > 0 ? 6 : 2 });
};
const ZERO = "0x0000000000000000000000000000000000000000";

// ---------------------------------------------------------------- chain io

async function connect() {
  if (!eth) return flash("No injected wallet found (MetaMask, Rabby, OKX Wallet…)");
  wallet = createWalletClient({ chain: net.chain, transport: custom(eth) });
  [account] = await wallet.requestAddresses();
  await ensureChain();
  await load();
}

async function ensureChain() {
  if (!wallet || !eth) return;
  const id = await wallet.getChainId();
  if (id === net.chain.id) return;
  try {
    await wallet.switchChain({ id: net.chain.id });
  } catch {
    await wallet.addChain({ chain: net.chain });
  }
}

async function load() {
  const who = watch ?? account;
  if (!who || !net.factory) return render();
  loading = true;
  render();
  try {
    const list = await pub.readContract({ address: net.factory, abi: factoryAbi, functionName: "jarsOf", args: [who] });
    views = await Promise.all(list.map((a) => readJar(a)));
  } catch (e) {
    flash(String((e as Error).message).slice(0, 160));
  }
  loading = false;
  render();
}

async function readJar(address: Address): Promise<JarView> {
  const [jarsRes, owner, unallocated] = await Promise.all([
    pub.readContract({ address, abi: arcJarAbi, functionName: "jars" }),
    pub.readContract({ address, abi: arcJarAbi, functionName: "owner" }),
    pub.readContract({ address, abi: arcJarAbi, functionName: "unallocated" }),
  ]);
  const [names, balances, bps, unlockAts, dests] = jarsRes;
  const rows = names.map((n, i) => ({
    name: hexToString(n, { size: 32 }).replace(/\0+$/, ""),
    balance: balances[i],
    bps: bps[i],
    unlockAt: Number(unlockAts[i]),
    dest: dests[i],
  }));
  return { address, owner, rows, unallocated };
}

async function write(req: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint }) {
  if (!wallet || !account) await connect();
  if (!wallet || !account) return;
  await ensureChain();
  try {
    const hash = await wallet.writeContract({ ...(req as object), account, chain: net.chain } as never);
    flash(`${t("sent")}: <a href="${explorerTx(net, hash)}" target="_blank" rel="noopener">${short(hash)}</a>`);
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  } catch (e) {
    flash(`${t("error")}: ${esc(((e as { shortMessage?: string }).shortMessage ?? String(e)).slice(0, 200))}`);
  }
}

// ---------------------------------------------------------------- rendering

function flash(msg: string) {
  toast = msg;
  render();
  setTimeout(() => {
    if (toast === msg) {
      toast = "";
      render();
    }
  }, 9000);
}

function countdown(unlockAt: number) {
  let s = unlockAt - Math.floor(Date.now() / 1000);
  if (s <= 0) return "";
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
}

const payUrl = (jar: string) => {
  // Share only network params; drop watch/lang/amount so the link is clean.
  const keep = new URLSearchParams();
  for (const k of ["net", "factory", "rpc"]) { const v = params.get(k); if (v) keep.set(k, v); }
  const q = keep.toString();
  return `${location.origin}${location.pathname}${q ? "?" + q : ""}#/pay/${jar}`;
};
const colors = ["#2ea043", "#d29922", "#1f6feb", "#a371f7", "#db61a2", "#3fb950", "#f85149", "#8b949e"];

function header() {
  const who = account ? short(account) : t("connect");
  return `
  <header>
    <a class="brand" href="#/"><img src="./favicon.svg" alt="" width="28" height="28"/> ArcJars</a>
    <span class="net">${esc(net.chain.name)}${wallet ? "" : ` · ${t("readOnly")}`}</span>
    <span class="spacer"></span>
    <button class="ghost" data-act="lang">${getLang() === "en" ? "中文" : "EN"}</button>
    <button data-act="connect">${who}</button>
  </header>`;
}

function jarCard(v: JarView) {
  const total = v.rows.reduce((a, r) => a + r.balance, 0n) + v.unallocated;
  const mine = account && v.owner.toLowerCase() === account.toLowerCase();
  const rows = v.rows
    .map((r, i) => {
      const pct = total === 0n ? 0 : Number((r.balance * 10000n) / total) / 100;
      const cd = countdown(r.unlockAt);
      const lock = cd
        ? `<span class="badge lock" data-unlock="${r.unlockAt}">🔒 ${t("unlocksIn")} <b>${cd}</b></span>`
        : r.unlockAt
          ? `<span class="badge open">🔓 ${t("unlocked")}</span>`
          : "";
      return `
      <div class="jar">
        <div class="jar-top">
          <span class="dot" style="background:${colors[i % colors.length]}"></span>
          <b>${esc(r.name || "#" + i)}</b>
          <span class="muted">${(r.bps / 100).toFixed(r.bps % 100 ? 2 : 0)}% ${t("share")}</span>
          <span class="spacer"></span>
          <span class="amt">${usd(r.balance)} <small>USDC</small></span>
        </div>
        <div class="bar"><div style="width:${pct}%;background:${colors[i % colors.length]}"></div></div>
        ${lock || r.dest !== ZERO || mine ? `<div class="jar-bottom">
          ${lock}
          ${r.dest !== ZERO ? `<span class="badge">→ ${short(r.dest)}</span>` : ""}
          <span class="spacer"></span>
          ${
            mine
              ? `<input class="wamt" data-jar="${v.address}" data-id="${i}" placeholder="0.00" inputmode="decimal" ${cd ? "disabled" : ""}/>
                 <button class="ghost small" data-act="max" data-jar="${v.address}" data-id="${i}" ${cd ? "disabled" : ""}>${t("max")}</button>
                 <button class="small" data-act="withdraw" data-jar="${v.address}" data-id="${i}" ${cd || r.balance === 0n ? "disabled" : ""}>${t("withdraw")}</button>`
              : ""
          }
        </div>` : ""}
      </div>`;
    })
    .join("");
  return `
  <section class="card">
    <div class="card-head">
      <div>
        <div class="muted">${t("total")}</div>
        <div class="big">${usd(total)} <small>USDC</small></div>
      </div>
      <span class="spacer"></span>
      <div class="addr">
        <a href="${explorerAddr(net, v.address)}" target="_blank" rel="noopener">${short(v.address)}</a>
        <button class="ghost small" data-act="copy" data-text="${payUrl(v.address)}">${t("payLink")}</button>
        <a class="button ghost small" href="#/pay/${v.address}">${t("qr")}</a>
      </div>
    </div>
    ${rows}
    ${
      v.unallocated > 0n
        ? `<div class="unalloc"><span>⏳ ${t("unallocated")}: <b>${usd(v.unallocated)} USDC</b></span><span class="spacer"></span>
           <button class="small" data-act="sweep" data-jar="${v.address}">${t("sweep")}</button></div>
           <p class="hint">${t("sweepHint")}</p>`
        : ""
    }
  </section>`;
}

function jarsTab() {
  if (!net.factory) return `<p class="empty">${t("noFactory")}</p>`;
  const who = watch ?? account;
  const watchForm = `<form class="watch" data-form="watch"><input name="w" placeholder="${t("watchPh")}" value="${watch ?? ""}"/><button class="ghost">${t("watch")}</button></form>`;
  if (!who) return `<p class="empty">${t("connectFirst")}</p>${watchForm}`;
  if (loading) return `<p class="empty">…</p>`;
  return (views.length ? views.map(jarCard).join("") : `<p class="empty">${t("noJars")}</p>`) + watchForm;
}

interface Draft {
  name: string;
  pct: string;
  lock: string;
  dest: string;
}
let drafts: Draft[] = [];
function defaultDrafts(): Draft[] {
  const y = new Date().getFullYear();
  const taxDay = new Date(Date.now() < Date.parse(`${y}-04-15`) ? `${y}-04-15` : `${y + 1}-04-15`);
  return [
    { name: t("presetTax"), pct: "25", lock: taxDay.toISOString().slice(0, 10), dest: "" },
    { name: t("presetProfit"), pct: "5", lock: "", dest: "" },
  ];
}

function createTab() {
  if (!drafts.length) drafts = defaultDrafts();
  const used = drafts.reduce((a, d) => a + (parseFloat(d.pct) || 0), 0);
  const rows = drafts
    .map(
      (d, i) => `
    <div class="draft">
      <label>${t("jarName")}<input data-d="${i}" data-k="name" value="${esc(d.name)}" maxlength="31"/></label>
      <label class="narrow">${t("percent")}<input data-d="${i}" data-k="pct" value="${esc(d.pct)}" inputmode="decimal"/></label>
      <label>${t("lockUntil")}<input type="date" data-d="${i}" data-k="lock" value="${esc(d.lock)}"/></label>
      <label class="wide">${t("dest")}<input data-d="${i}" data-k="dest" value="${esc(d.dest)}" placeholder="0x…"/></label>
      <button class="ghost small" data-act="rm" data-d="${i}">${t("remove")}</button>
    </div>`,
    )
    .join("");
  return `
  <section class="card">
    ${rows}
    <div class="row">
      <button class="ghost small" data-act="add" ${drafts.length >= 7 ? "disabled" : ""}>+ ${t("addJar")}</button>
      <span class="spacer"></span>
      <span>${t("spendableGets")} <b class="${used > 100 ? "bad" : ""}">${(100 - used).toFixed(2).replace(/\.00$/, "")}%</b></span>
    </div>
    <button class="primary" data-act="create" ${used > 100 || !net.factory ? "disabled" : ""}>${t("createBtn")}</button>
    <p class="hint">${t("fees")}</p>
  </section>`;
}

async function payPage(jar: Address) {
  let v: JarView | undefined;
  try {
    v = await readJar(jar);
  } catch {
    /* not deployed yet: still allow paying the predicted address */
  }
  const link = payUrl(jar);
  const qr = await QRCode.toDataURL(link, { margin: 1, width: 220, color: { dark: "#0d1117", light: "#ffffff" } });
  const split = v
    ? `<div class="stack">${v.rows
        .map(
          (r, i) =>
            `<div style="flex:${r.bps};background:${colors[i % colors.length]}" title="${esc(r.name)}">${r.bps >= 800 ? `${esc(r.name)} ${r.bps / 100}%` : ""}</div>`,
        )
        .join("")}</div>`
    : "";
  return `
  <section class="card pay">
    <h2>${t("payTitle")} <a href="${explorerAddr(net, jar)}" target="_blank" rel="noopener">${short(jar)}</a></h2>
    <p class="muted">${t("payTo")}</p>
    ${split}
    <div class="pay-grid">
      <img src="${qr}" alt="QR" width="220" height="220"/>
      <form data-form="pay" data-jar="${jar}">
        <label>${t("amount")}<input name="amount" value="${esc(params.get("amount") ?? "")}" placeholder="10.00" inputmode="decimal" required/></label>
        <label>${t("invoice")}<input name="memo" value="${esc(params.get("memo") ?? "")}" placeholder="INV-2026-001" maxlength="64"/></label>
        <button class="primary">${t("payBtn")}</button>
        <p class="hint">${t("memoNote")}</p>
      </form>
    </div>
    <div class="row"><code class="link">${esc(link)}</code><button class="ghost small" data-act="copy" data-text="${esc(link)}">${t("copy")}</button></div>
    <p class="warn">⚠️ ${t("exchangeWarn")}</p>
  </section>`;
}

async function render() {
  const route = location.hash.match(/^#\/pay\/(0x[0-9a-fA-F]{40})/);
  let body: string;
  if (route) {
    body = await payPage(getAddress(route[1]));
  } else {
    body = `
    <div class="hero"><h1>${t("tagline")}</h1><p>${t("sub")}</p></div>
    <nav>
      <button class="${tab === "jars" ? "on" : ""}" data-act="tab" data-tab="jars">${t("myJars")}</button>
      <button class="${tab === "create" ? "on" : ""}" data-act="tab" data-tab="create">${t("create")}</button>
    </nav>
    ${tab === "jars" ? jarsTab() : createTab()}`;
  }
  app.innerHTML = `${header()}<main>${body}</main>
    ${toast ? `<div class="toast">${toast}</div>` : ""}
    <footer>${t("footer")} · <a href="https://github.com/whhhh1500/arcjars" target="_blank" rel="noopener">GitHub</a> · ${t("fees")}</footer>`;
}

// ---------------------------------------------------------------- events

app.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  if (act === "connect") return connect();
  if (act === "lang") {
    setLang(getLang() === "en" ? "zh" : "en");
    drafts = [];
    return render();
  }
  if (act === "tab") {
    tab = el.dataset.tab as typeof tab;
    return render();
  }
  if (act === "copy") {
    await navigator.clipboard?.writeText(el.dataset.text ?? "");
    return flash(t("copied"));
  }
  if (act === "add") {
    drafts.push({ name: "", pct: "0", lock: "", dest: "" });
    return render();
  }
  if (act === "rm") {
    drafts.splice(Number(el.dataset.d), 1);
    return render();
  }
  if (act === "sweep") {
    await write({ address: el.dataset.jar as Address, abi: arcJarAbi, functionName: "sweep" });
    return load();
  }
  if (act === "max" || act === "withdraw") {
    const jar = el.dataset.jar as Address;
    const id = Number(el.dataset.id);
    const v = views.find((x) => x.address === jar)!;
    const input = app.querySelector<HTMLInputElement>(`input.wamt[data-jar="${jar}"][data-id="${id}"]`)!;
    if (act === "max") {
      input.value = formatUnits(v.rows[id].balance, 18);
      return;
    }
    const amount = input.value ? parseUnits(input.value, 18) : 0n;
    if (amount === 0n) return;
    const all = amount >= v.rows[id].balance;
    await write({
      address: jar,
      abi: arcJarAbi,
      functionName: "withdraw",
      args: [BigInt(id), all ? 2n ** 256n - 1n : amount, account!],
    });
    return load();
  }
  if (act === "create") {
    const configs = drafts.map((d) => ({
      name: toHex(d.name.slice(0, 31) || "Jar", { size: 32 }),
      bps: Math.round((parseFloat(d.pct) || 0) * 100),
      unlockAt: d.lock ? BigInt(Math.floor(Date.parse(d.lock + "T00:00:00") / 1000)) : 0n,
      dest: (isAddress(d.dest) ? getAddress(d.dest) : ZERO) as Address,
    }));
    const salt = keccak256(toHex(`${Date.now()}-${Math.random()}`));
    const h = await write({ address: net.factory as Address, abi: factoryAbi, functionName: "createJar", args: [salt, configs] });
    if (h) {
      tab = "jars";
      await load();
      flash(t("created") + ` <a href="#/pay/${views.at(-1)?.address ?? ""}">${t("payLink")}</a>`);
    }
  }
});

app.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.d !== undefined && el.dataset.k) {
    (drafts[Number(el.dataset.d)] as unknown as Record<string, string>)[el.dataset.k] = el.value;
    if (el.dataset.k === "pct") {
      const used = drafts.reduce((a, d) => a + (parseFloat(d.pct) || 0), 0);
      const b = app.querySelector(".row b");
      if (b) {
        b.textContent = `${(100 - used).toFixed(2).replace(/\.00$/, "")}%`;
        b.classList.toggle("bad", used > 100);
      }
      app.querySelector<HTMLButtonElement>('[data-act="create"]')!.disabled = used > 100;
    }
  }
});

app.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const data = new FormData(form);
  if (form.dataset.form === "watch") {
    const w = String(data.get("w") ?? "").trim();
    watch = isAddress(w) ? getAddress(w) : undefined;
    return load();
  }
  if (form.dataset.form === "pay") {
    const jar = form.dataset.jar as Address;
    const amount = String(data.get("amount") ?? "").trim();
    const memo = String(data.get("memo") ?? "").trim();
    if (!wallet || !account) await connect();
    if (!wallet || !account) return;
    await ensureChain();
    try {
      let hash: Hex;
      if (!memo) {
        hash = await wallet.sendTransaction({ account, chain: net.chain, to: jar, value: parseUnits(amount, 18) });
      } else {
        const inner = encodeFunctionData({
          abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
          functionName: "transfer",
          args: [jar, parseUnits(amount, 6)],
        });
        hash = await wallet.writeContract({
          account,
          chain: net.chain,
          address: MEMO,
          abi: [{ type: "function", name: "memo", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "bytes" }, { type: "bytes32" }, { type: "bytes" }], outputs: [] }],
          functionName: "memo",
          args: [USDC_ERC20, inner, keccak256(stringToHex(memo)), stringToHex(`invoice=${memo}`)],
        });
      }
      flash(`${t("sent")}: <a href="${explorerTx(net, hash)}" target="_blank" rel="noopener">${short(hash)}</a>`);
    } catch (err) {
      flash(`${t("error")}: ${esc(((err as { shortMessage?: string }).shortMessage ?? String(err)).slice(0, 200))}`);
    }
  }
});

window.addEventListener("hashchange", () => render());
// live lock countdowns
setInterval(() => {
  app.querySelectorAll<HTMLElement>("[data-unlock]").forEach((el) => {
    const cd = countdown(Number(el.dataset.unlock));
    const b = el.querySelector("b");
    if (b && cd) b.textContent = cd;
  });
}, 1000);
(eth as unknown as { on?: (ev: string, cb: () => void) => void })?.on?.("accountsChanged", () => connect());

render();
load();
