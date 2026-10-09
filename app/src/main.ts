import "./style.css";
import QRCode from "qrcode";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
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
import { MEMO, NETWORKS, USDC_ERC20, explorerAddr, explorerTx, resolveNetwork } from "./config";
import { getLang, setLang, t, type Key } from "./i18n";

// ================================================================ state

const params = new URLSearchParams(location.search);
const net = resolveNetwork(params);
const bakedFactory = NETWORKS.find((n) => n.key === net.key)?.factory ?? "";
const factoryOverridden = !!params.get("factory") && params.get("factory")!.toLowerCase() !== bakedFactory.toLowerCase();
const rpcOverridden = !!params.get("rpc");
const pub = createPublicClient({ chain: net.chain, transport: http() });
type Eip1193 = { request: (a: unknown) => Promise<unknown>; on?: (ev: string, cb: () => void) => void };
const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;

let wallet: WalletClient | undefined;
let account: Address | undefined;
let watch: Address | undefined = isAddress(params.get("watch") ?? "") ? getAddress(params.get("watch")!) : undefined;
let busy = ""; // key of the action in flight (disables its button)

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
const withdrawInputs: Record<string, string> = {};

type Verify = "verified" | "none" | "unverified" | "unknown";
interface PayState {
  jar: Address;
  view?: JarView;
  verify: Verify;
  balance?: bigint;
  done?: { hash: Hex; memo: boolean; amount: string };
}
let pay: PayState | undefined;
let payAmount = params.get("amount") ?? "";
let payMemo = params.get("memo") ?? "";

const app = document.querySelector<HTMLDivElement>("#app")!;
const toastEl = document.createElement("div");
toastEl.setAttribute("role", "status");
toastEl.setAttribute("aria-live", "polite");
document.body.appendChild(toastEl);

// ================================================================ helpers

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_U256 = 2n ** 256n - 1n;
const colors = ["#3fb68b", "#e3a33b", "#5b8def", "#a879f0", "#e26fa8", "#4fc3d9", "#ef6b5b", "#9aa4b2"];
const utf8Len = (s: string) => new TextEncoder().encode(s).length;
const AMOUNT_RE = /^(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/;

function usd(v: bigint, maxFrac = 2) {
  const n = Number(formatUnits(v, 18));
  const frac = n > 0 && n < 0.01 ? 6 : maxFrac;
  return n.toLocaleString(getLang() === "zh" ? "zh-CN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: frac });
}
const pctText = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0).replace(/(\.\d)0$/, "$1")}%`;
const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(getLang() === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: "short", day: "numeric" });
const decodeName = (n: Hex) => {
  try {
    return hexToString(n, { size: 32 }).replace(/\0+$/, "");
  } catch {
    return "";
  }
};
/** EIP-1167 runtime code of a clone of `impl`. */
const cloneCode = (impl: string) => `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;

function payUrl(jar: string, extra?: { amount?: string; memo?: string }) {
  const keep = new URLSearchParams();
  for (const k of ["net", "factory", "rpc"]) {
    const v = params.get(k);
    if (v) keep.set(k, v);
  }
  if (extra?.amount) keep.set("amount", extra.amount);
  if (extra?.memo) keep.set("memo", extra.memo);
  const q = keep.toString();
  return `${location.origin}${location.pathname}${q ? "?" + q : ""}#/pay/${jar}`;
}

// ================================================================ toast + errors

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** `html` must already be safe; use esc() on anything external. */
function toast(kind: "ok" | "err" | "info", html: string, ms = 7000) {
  toastEl.className = `toast ${kind}`;
  toastEl.innerHTML = `<span>${html}</span><button class="x" aria-label="close">×</button>`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
}
toastEl.hidden = true;
toastEl.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).classList.contains("x")) toastEl.hidden = true;
});

const revertMsg: Record<string, Key> = {
  NotOwner: "errNotOwner",
  InsufficientJarBalance: "errBalance",
  NothingToSweep: "errNothing",
  TransferFailed: "errTransfer",
  BpsOverflow: "errBps",
  TooManyJars: "errTooMany",
  LockTooFar: "errLockFar",
  BadDest: "vDest",
  ZeroAddress: "vDest",
};

/** Turn any wallet/RPC/contract error into one short, human sentence (already HTML-escaped). */
function friendly(e: unknown): string {
  const err = e as { code?: number; name?: string; shortMessage?: string; message?: string };
  if (err?.code === 4001 || err?.name === "UserRejectedRequestError" || /user (rejected|denied)/i.test(err?.message ?? ""))
    return esc(t("errRejected"));
  if (/insufficient funds/i.test(err?.message ?? "")) return esc(t("errFunds"));
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = rev?.data?.errorName;
    if (name === "Locked") return esc(`${t("errLocked")} ${fmtDate(Number(rev!.data!.args?.[0] ?? 0))}.`);
    if (name && revertMsg[name]) return esc(t(revertMsg[name]));
  }
  const msg = err?.shortMessage ?? err?.message ?? String(e);
  return esc(msg.split("\n")[0].slice(0, 180));
}

// ================================================================ chain io

async function connect(): Promise<boolean> {
  if (!eth) {
    toast("err", esc(t("errNoWallet")), 10000);
    return false;
  }
  try {
    wallet = createWalletClient({ chain: net.chain, transport: custom(eth) });
    [account] = await wallet.requestAddresses();
    await ensureChain();
  } catch (e) {
    toast("err", friendly(e));
    return false;
  }
  await Promise.all([load(), refreshPayBalance()]);
  return true;
}

async function ensureChain() {
  if (!wallet) return;
  if ((await wallet.getChainId()) === net.chain.id) return;
  try {
    await wallet.switchChain({ id: net.chain.id });
  } catch {
    try {
      await wallet.addChain({ chain: net.chain });
      await wallet.switchChain({ id: net.chain.id });
    } catch {
      throw new Error(t("errChain"));
    }
  }
}

async function load() {
  const who = watch ?? account;
  if (!who || !net.factory) return render();
  loading = true;
  render();
  try {
    const list = await pub.readContract({ address: net.factory, abi: factoryAbi, functionName: "jarsOf", args: [who] });
    const unique = [...new Set(list.map((a) => getAddress(a)))];
    const all = await Promise.all(unique.map((a) => readJar(a)));
    // jarsOf is append-only; a jar that was transferred away stays in the old list.
    views = all.filter((v) => v.owner.toLowerCase() === who.toLowerCase()).reverse();
  } catch (e) {
    views = [];
    toast("err", friendly(e));
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
    // jar 0 is always named "Spendable" on-chain; show it in the UI language
    name: i === 0 && decodeName(n) === "Spendable" ? t("spendable") : decodeName(n) || `#${i}`,
    balance: balances[i],
    bps: bps[i],
    unlockAt: Number(unlockAts[i]),
    dest: dests[i],
  }));
  return { address, owner, rows, unallocated };
}

/** Send a contract write, wait for the receipt, and report the real outcome. */
async function write(key: string, req: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) {
  if (!wallet || !account) if (!(await connect())) return;
  busy = key;
  render();
  try {
    await ensureChain();
    const hash = await wallet!.writeContract({ ...(req as object), account, chain: net.chain } as never);
    toast("info", `${esc(t("sent"))} · <a href="${explorerTx(net, hash)}" target="_blank" rel="noopener">${short(hash)}</a>`, 30000);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error(t("errReverted"));
    toast("ok", `${esc(t("confirmed"))} · <a href="${explorerTx(net, hash)}" target="_blank" rel="noopener">${short(hash)}</a>`);
    return rc;
  } catch (e) {
    toast("err", friendly(e), 10000);
  } finally {
    busy = "";
  }
}

// ================================================================ pay page data

async function loadPay(jar: Address) {
  pay = { jar, verify: "unknown" };
  render();
  const code = await pub.getCode({ address: jar }).catch(() => undefined);
  if (!code || code === "0x") {
    pay.verify = "none";
  } else {
    try {
      if (!net.factory) throw new Error("no factory");
      const impl = await pub.readContract({ address: net.factory, abi: factoryAbi, functionName: "implementation" });
      pay.verify = code.toLowerCase() === cloneCode(impl) ? "verified" : "unverified";
    } catch {
      pay.verify = "unknown";
    }
    try {
      pay.view = await readJar(jar);
    } catch {
      if (pay.verify === "unknown") pay.verify = "unverified";
    }
  }
  await refreshPayBalance();
  render();
}

async function refreshPayBalance() {
  if (!pay || !account) return;
  pay.balance = await pub.getBalance({ address: account }).catch(() => undefined);
  render();
}

// ================================================================ rendering

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

const icon = {
  lock: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M4 7V5a4 4 0 1 1 8 0v2h.5A1.5 1.5 0 0 1 14 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-5A1.5 1.5 0 0 1 3.5 7H4Zm2 0h4V5a2 2 0 1 0-4 0v2Z"/></svg>`,
  check: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.2 11.4 2.8 8l-1.1 1.1 4.5 4.5 8.1-8.1-1.1-1.1z"/></svg>`,
  warn: `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 1 0 15h16L8 1Zm-.8 5h1.6v4.5H7.2V6Zm0 5.8h1.6v1.6H7.2v-1.6Z"/></svg>`,
  arrow: `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M9 3 7.9 4.1l3.1 3.1H2v1.6h9l-3.1 3.1L9 13l5-5z"/></svg>`,
};

function header() {
  const testnet = !!net.chain.testnet;
  return `
  <header>
    <a class="brand" href="#/"><img src="./favicon.svg" alt="" width="28" height="28"/><span>ArcJars</span></a>
    <span class="net ${testnet ? "test" : "main"}"><i></i>${esc(net.chain.name)}</span>
    <span class="spacer"></span>
    <button class="ghost small" data-act="lang" aria-label="language">${getLang() === "en" ? "中文" : "EN"}</button>
    ${
      account
        ? `<span class="acct" title="${account}"><i></i>${short(account)}</span>`
        : `<button class="small" data-act="connect">${t("connect")}</button>`
    }
  </header>
  ${
    factoryOverridden || rpcOverridden
      ? `<div class="banner warn">${icon.warn}<span><b>${factoryOverridden ? t("customFactory") : t("customRpc")}</b> ${
          factoryOverridden ? `<code>${esc(short(net.factory))}</code>` : ""
        } · ${t("customFactoryD")}</span></div>`
      : ""
  }`;
}

function splitBar(rows: { name: string; bps: number }[], legend = true) {
  const shown = rows.filter((r) => r.bps > 0);
  return `
  <div class="stack" role="img" aria-label="${esc(shown.map((r) => `${r.name} ${pctText(r.bps)}`).join(", "))}">
    ${shown.map((r) => `<div style="flex:${r.bps};background:${colors[rows.indexOf(r) % colors.length]}"></div>`).join("")}
  </div>
  ${
    legend
      ? `<div class="legend">${shown
          .map((r) => `<span><i style="background:${colors[rows.indexOf(r) % colors.length]}"></i>${esc(r.name)} <b>${pctText(r.bps)}</b></span>`)
          .join("")}</div>`
      : ""
  }`;
}

function jarCard(v: JarView) {
  const total = v.rows.reduce((a, r) => a + r.balance, 0n) + v.unallocated;
  const mine = !!account && v.owner.toLowerCase() === account.toLowerCase();
  const rows = v.rows
    .map((r, i) => {
      const cd = countdown(r.unlockAt);
      const key = `${v.address}:${i}`;
      const lock = cd
        ? `<span class="badge lock" data-unlock="${r.unlockAt}" title="${t("lockedUntil")} ${fmtDate(r.unlockAt)}">${icon.lock} ${t("unlocksIn")} <b>${cd}</b></span>`
        : r.unlockAt
          ? `<span class="badge open">${t("unlockedOn")}</span>`
          : "";
      const pct = total === 0n ? 0 : Number((r.balance * 10000n) / total) / 100;
      return `
      <div class="jar">
        <div class="jar-top">
          <span class="dot" style="background:${colors[i % colors.length]}"></span>
          <div class="jar-name"><b>${esc(r.name)}</b><span class="muted">${t("share").replace("{p}", pctText(r.bps))}</span></div>
          <span class="spacer"></span>
          <span class="amt">${usd(r.balance)} <small>USDC</small></span>
        </div>
        <div class="bar"><div style="width:${pct}%;background:${colors[i % colors.length]}"></div></div>
        ${
          lock || r.dest !== ZERO || mine
            ? `<div class="jar-bottom">
          ${lock}
          ${r.dest !== ZERO ? `<span class="badge" title="${r.dest}">${icon.arrow} ${t("paysTo")} ${short(r.dest)}</span>` : ""}
          <span class="spacer"></span>
          ${
            mine
              ? `<div class="wd">
                  <input class="wamt" data-key="${key}" value="${esc(withdrawInputs[key] ?? "")}" placeholder="0.00" inputmode="decimal" aria-label="${t("withdraw")}" ${cd ? "disabled" : ""}/>
                  <button class="ghost small" data-act="max" data-jar="${v.address}" data-id="${i}" ${cd || r.balance === 0n ? "disabled" : ""}>${t("max")}</button>
                  <button class="small" data-act="withdraw" data-jar="${v.address}" data-id="${i}" ${cd || r.balance === 0n || busy ? "disabled" : ""}>${busy === "w:" + key ? "…" : t("withdraw")}</button>
                </div>`
              : ""
          }
        </div>`
            : ""
        }
      </div>`;
    })
    .join("");
  return `
  <section class="card">
    <div class="card-head">
      <div>
        <div class="label">${t("total")}</div>
        <div class="big">${usd(total)} <small>USDC</small></div>
        <a class="mono muted" href="${explorerAddr(net, v.address)}" target="_blank" rel="noopener">${short(v.address)}</a>
      </div>
      <span class="spacer"></span>
      <div class="actions">
        <button class="ghost small" data-act="copy" data-text="${esc(payUrl(v.address))}">${t("copyLink")}</button>
        <a class="button small" href="#/pay/${v.address}">${t("sharePay")}</a>
      </div>
    </div>
    ${splitBar(v.rows, false)}
    ${rows}
    ${
      v.unallocated > 0n
        ? `<div class="unalloc"><span>${t("unallocated")}: <b>${usd(v.unallocated)} USDC</b></span><span class="spacer"></span>
           <button class="small" data-act="sweep" data-jar="${v.address}" ${busy ? "disabled" : ""}>${busy === "s:" + v.address ? "…" : t("sweep")}</button>
           <p class="hint">${t("sweepHint")}</p></div>`
        : ""
    }
  </section>`;
}

function hero() {
  return `
  <section class="hero">
    <h1>${t("tagline")}</h1>
    <p>${t("sub")}</p>
    <ol class="steps">
      <li><b>1</b><div><h3>${t("step1")}</h3><p>${t("step1d")}</p></div></li>
      <li><b>2</b><div><h3>${t("step2")}</h3><p>${t("step2d")}</p></div></li>
      <li><b>3</b><div><h3>${t("step3")}</h3><p>${t("step3d")}</p></div></li>
    </ol>
  </section>`;
}

function watchForm() {
  return `<form class="watch" data-form="watch"><input name="w" placeholder="${t("watchPh")}" value="${watch ?? ""}" aria-label="${t("watchPh")}" spellcheck="false" autocomplete="off"/><button class="ghost">${t("watch")}</button></form>`;
}

function jarsTab() {
  if (!net.factory) return `<div class="empty card"><p>${t("noFactory")}</p></div>`;
  const who = watch ?? account;
  if (!who)
    return `<div class="empty card">
      <h3>${t("connectFirstT")}</h3><p>${t("connectFirst")}</p>
      <div class="row center"><button data-act="connect">${t("connect")}</button></div>
      ${watchForm()}
    </div>`;
  const viewing = watch
    ? `<div class="viewing">${t("viewing")} <code>${short(watch)}</code> · ${t("readOnly")}${account ? ` · <a href="#/" data-act="unwatch">${t("clearWatch")}</a>` : ""}</div>`
    : "";
  if (loading) return `${viewing}<section class="card skeleton"><div></div><div></div><div></div></section>`;
  if (!views.length)
    return `${viewing}<div class="empty card">
      <h3>${t("noJars")}</h3><p>${t("noJarsD")}</p>
      <div class="row center"><a class="button" href="#/create">${t("ctaCreate")}</a></div>
      ${watch ? "" : watchForm()}
    </div>`;
  return viewing + views.map(jarCard).join("") + watchForm();
}

// ---------------------------------------------------------------- create

interface Draft {
  name: string;
  pct: string;
  lock: string;
  dest: string;
}
let drafts: Draft[] = [];
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function nextTaxDay() {
  const y = new Date().getFullYear();
  const thisYear = new Date(y, 3, 15);
  return isoDay(Date.now() < thisYear.getTime() ? thisYear : new Date(y + 1, 3, 15));
}
function template(kind: "freelancer" | "saver" | "blank"): Draft[] {
  if (kind === "saver")
    return [
      { name: t("presetEmergency"), pct: "10", lock: isoDay(new Date(Date.now() + 90 * 86400e3)), dest: "" },
      { name: t("presetSavings"), pct: "20", lock: "", dest: "" },
    ];
  if (kind === "blank") return [{ name: "", pct: "10", lock: "", dest: "" }];
  return [
    { name: t("presetTax"), pct: "25", lock: nextTaxDay(), dest: "" },
    { name: t("presetProfit"), pct: "5", lock: "", dest: "" },
  ];
}

function draftErrors(d: Draft): Key[] {
  const errs: Key[] = [];
  if (!d.name.trim()) errs.push("vNameEmpty");
  else if (utf8Len(d.name.trim()) > 31) errs.push("vName");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(d.pct.trim()) || parseFloat(d.pct) > 100) errs.push("vPct");
  if (d.lock) {
    const ts = Date.parse(d.lock + "T00:00:00");
    if (!(ts > Date.now())) errs.push("vLockPast");
    else if (ts > Date.now() + 3649 * 86400e3) errs.push("vLockFar");
  }
  if (d.dest.trim() && !isAddress(d.dest.trim())) errs.push("vDest");
  return errs;
}
const bpsOf = (d: Draft) => Math.round((parseFloat(d.pct) || 0) * 100);

function createSummary() {
  const used = drafts.reduce((a, d) => a + bpsOf(d), 0);
  const allErrs = drafts.map(draftErrors);
  const ok = used <= 10000 && allErrs.every((e) => !e.length) && !!net.factory;
  const rows = [{ name: t("spendable"), bps: Math.max(0, 10000 - used) }, ...drafts.map((d) => ({ name: d.name.trim() || "—", bps: bpsOf(d) }))];
  const net1000 = 999; // 1,000 USDC minus the 1 USDC capped fee
  const example = rows
    .filter((r) => r.bps > 0)
    .map((r) => `${esc(r.name)} <b>${((net1000 * r.bps) / 10000).toLocaleString(undefined, { maximumFractionDigits: 2 })}</b>`)
    .join(" · ");
  return { used, ok, html: `
    ${splitBar(rows)}
    <div class="row between">
      <span>${t("spendableGets")}: <b class="${used > 10000 ? "bad" : ""}">${pctText(10000 - used)}</b></span>
    </div>
    ${used > 10000 ? `<p class="err">${t("vTotal")}</p>` : `<p class="hint">${t("example")} ${example} · fee <b>1</b></p>`}` };
}

function createTab() {
  if (!drafts.length) drafts = template("freelancer");
  const s = createSummary();
  const rows = drafts
    .map((d, i) => {
      const errs = draftErrors(d);
      return `
    <div class="draft">
      <span class="dot" style="background:${colors[(i + 1) % colors.length]}"></span>
      <label>${t("jarName")}<input data-d="${i}" data-k="name" value="${esc(d.name)}" maxlength="31" autocomplete="off"/></label>
      <label class="narrow">${t("percent")}<input data-d="${i}" data-k="pct" value="${esc(d.pct)}" inputmode="decimal"/></label>
      <label>${t("lockUntil")}<input type="date" data-d="${i}" data-k="lock" value="${esc(d.lock)}" min="${isoDay(new Date(Date.now() + 86400e3))}"/></label>
      <label class="wide">${t("dest")}<input data-d="${i}" data-k="dest" value="${esc(d.dest)}" placeholder="0x…" spellcheck="false" autocomplete="off"/></label>
      <button class="ghost small icon" data-act="rm" data-d="${i}" aria-label="${t("remove")}" title="${t("remove")}">✕</button>
      ${errs.length ? `<p class="err full">${errs.map((k) => t(k)).join(" ")}</p>` : ""}
    </div>`;
    })
    .join("");
  return `
  <section class="card create">
    <div class="row tpl"><span class="label">${t("templates")}</span>
      <button class="chip" data-act="tpl" data-tpl="freelancer">${t("tplFreelancer")}</button>
      <button class="chip" data-act="tpl" data-tpl="saver">${t("tplSaver")}</button>
      <button class="chip" data-act="tpl" data-tpl="blank">${t("tplBlank")}</button>
    </div>
    <div class="draft spend"><span class="dot" style="background:${colors[0]}"></span><b>${t("spendable")}</b><span class="muted">${t("spendableGets")}</span></div>
    ${rows}
    <button class="ghost small" data-act="add" ${drafts.length >= 7 ? "disabled" : ""}>+ ${t("addJar")}</button>
    <div class="summary" id="summary">${s.html}</div>
    <button class="primary" data-act="create" ${s.ok && !busy ? "" : "disabled"}>${busy === "create" ? t("creating") : t("createBtn")}</button>
    <p class="hint">${t("lockNote")} ${t("fees")}</p>
  </section>`;
}

// ---------------------------------------------------------------- pay

function payValidation(): Key | "" {
  const a = payAmount.trim();
  if (!AMOUNT_RE.test(a) || parseUnits(a, 18) === 0n) return "vAmount";
  if (payMemo.length > 64) return "vMemo";
  if (pay?.balance !== undefined && parseUnits(a, 18) >= pay.balance) return "vFunds";
  return "";
}

function payPage() {
  if (!pay) return "";
  const p = pay;
  const v = p.view;
  const badge =
    p.verify === "verified"
      ? `<div class="banner ok">${icon.check}<span><b>${t("verified")}</b> · ${t("verifiedD")}</span></div>`
      : p.verify === "none"
        ? `<div class="banner warn">${icon.warn}<span><b>${t("notCreated")}</b> · ${t("notCreatedD")}</span></div>`
        : p.verify === "unverified"
          ? `<div class="banner bad">${icon.warn}<span><b>${t("unverified")}</b> · ${t("unverifiedD")}</span></div>`
          : "";
  if (p.done) {
    return `
    <section class="card pay done">
      <div class="big-check">${icon.check}</div>
      <h2>${t("paid")}: ${esc(p.done.amount)} USDC</h2>
      <p class="muted">${p.done.memo ? t("paidMemo") : t("paidSplit")}</p>
      <p><a href="${explorerTx(net, p.done.hash)}" target="_blank" rel="noopener" class="mono">${short(p.done.hash)} ↗</a></p>
      <button class="ghost" data-act="payagain">${t("payAgain")}</button>
    </section>`;
  }
  const verr = payAmount ? payValidation() : "";
  return `
  <section class="card pay">
    <div class="pay-head">
      <div>
        <div class="label">${t("payTitle")}</div>
        <h2 class="mono"><a href="${explorerAddr(net, p.jar)}" target="_blank" rel="noopener">${short(p.jar)}</a></h2>
        ${v ? `<div class="muted">${t("owner")} <span class="mono">${short(v.owner)}</span></div>` : ""}
      </div>
    </div>
    ${badge}
    ${v ? `<p class="muted">${t("payTo")}</p>${splitBar(v.rows)}` : ""}
    <div class="pay-grid">
      <form data-form="pay" novalidate>
        <label>${t("amount")}
          <div class="amount"><input name="amount" value="${esc(payAmount)}" placeholder="0.00" inputmode="decimal" autocomplete="off" required/><span>USDC</span></div>
        </label>
        ${p.balance !== undefined ? `<div class="muted small">${t("balance")}: ${usd(p.balance)} USDC</div>` : ""}
        <label>${t("invoice")}<input name="memo" value="${esc(payMemo)}" placeholder="INV-2026-001" maxlength="64" autocomplete="off"/></label>
        <p class="err" id="payerr">${verr ? t(verr) : ""}</p>
        <button class="primary" id="paybtn" ${busy ? "disabled" : ""}>${busy === "pay" ? t("paying") : !account ? t("connect") : AMOUNT_RE.test(payAmount.trim()) ? t("payBtnAmt").replace("{a}", esc(payAmount.trim())) : t("payBtn")}</button>
        <p class="hint">${t("memoNote")}</p>
      </form>
      <div class="qr">
        <img id="qr" alt="QR" width="200" height="200"/>
        <div class="label">${t("requestLink")}</div>
        <div class="row"><code class="link" id="reqlink"></code><button class="ghost small" data-act="copyreq">${t("copy")}</button></div>
        <p class="hint">${t("requestHint")}</p>
      </div>
    </div>
    <p class="warn small">${t("exchangeWarn")}</p>
  </section>`;
}

let qrTimer: ReturnType<typeof setTimeout> | undefined;
function currentRequestLink() {
  return pay ? payUrl(pay.jar, { amount: AMOUNT_RE.test(payAmount.trim()) ? payAmount.trim() : "", memo: payMemo.trim() }) : "";
}
function updateQr() {
  clearTimeout(qrTimer);
  qrTimer = setTimeout(async () => {
    const img = document.getElementById("qr") as HTMLImageElement | null;
    const code = document.getElementById("reqlink");
    if (!img || !pay) return;
    const link = currentRequestLink();
    if (code) code.textContent = link;
    img.src = await QRCode.toDataURL(link, { margin: 1, width: 400, errorCorrectionLevel: "M", color: { dark: "#0b1220", light: "#ffffff" } });
  }, 120);
}

// ---------------------------------------------------------------- shell

function route(): { kind: "pay"; jar: Address } | { kind: "create" } | { kind: "jars" } {
  const m = location.hash.match(/^#\/pay\/(0x[0-9a-fA-F]{40})/);
  if (m) return { kind: "pay", jar: getAddress(m[1]) };
  if (location.hash.startsWith("#/create")) return { kind: "create" };
  return { kind: "jars" };
}

function render() {
  const r = route();
  let body: string;
  if (r.kind === "pay") {
    body = payPage();
  } else {
    const showHero = r.kind === "create" || !(watch ?? account) || (!loading && !views.length);
    body = `
    ${showHero ? hero() : ""}
    <nav>
      <a class="tab ${r.kind === "jars" ? "on" : ""}" href="#/">${t("myJars")}</a>
      <a class="tab ${r.kind === "create" ? "on" : ""}" href="#/create">${t("create")}</a>
    </nav>
    ${r.kind === "jars" ? jarsTab() : createTab()}`;
  }
  app.innerHTML = `${header()}<main>${body}</main>
    <footer>${t("footer")} · <a href="https://github.com/whhhh1500/arcjars" target="_blank" rel="noopener">GitHub</a><br/>${t("fees")}</footer>`;
  if (r.kind === "pay") updateQr();
}

function onRoute() {
  const r = route();
  if (r.kind === "pay" && pay?.jar !== r.jar) {
    loadPay(r.jar);
    return;
  }
  render();
  window.scrollTo(0, 0);
}

// ================================================================ events

app.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  if (act === "connect") return void connect();
  if (act === "lang") {
    setLang(getLang() === "en" ? "zh" : "en");
    drafts = [];
    return render();
  }
  if (act === "unwatch") {
    e.preventDefault();
    watch = undefined;
    return load();
  }
  if (act === "copy" || act === "copyreq") {
    const text = act === "copyreq" ? currentRequestLink() : el.dataset.text ?? "";
    try {
      await navigator.clipboard.writeText(text);
      toast("ok", esc(t("copied")), 2500);
    } catch {
      toast("info", esc(text), 10000);
    }
    return;
  }
  if (act === "tpl") {
    drafts = template(el.dataset.tpl as "freelancer" | "saver" | "blank");
    return render();
  }
  if (act === "add") {
    drafts.push({ name: "", pct: "0", lock: "", dest: "" });
    return render();
  }
  if (act === "rm") {
    drafts.splice(Number(el.dataset.d), 1);
    return render();
  }
  if (act === "payagain") {
    if (pay) pay.done = undefined;
    payAmount = "";
    payMemo = "";
    return render();
  }
  if (act === "sweep") {
    const jar = el.dataset.jar as Address;
    await write(`s:${jar}`, { address: jar, abi: arcJarAbi, functionName: "sweep" });
    return load();
  }
  if (act === "max" || act === "withdraw") {
    const jar = el.dataset.jar as Address;
    const id = Number(el.dataset.id);
    const key = `${jar}:${id}`;
    const v = views.find((x) => x.address === jar);
    if (!v) return;
    const bal = v.rows[id].balance;
    if (act === "max") {
      withdrawInputs[key] = formatUnits(bal, 18);
      return render();
    }
    const raw = (withdrawInputs[key] ?? "").trim();
    if (!/^\d*\.?\d+$/.test(raw) || parseUnits(raw, 18) === 0n) return toast("err", esc(t("vAmount")));
    const amount = parseUnits(raw, 18);
    if (amount > bal) return toast("err", esc(t("errBalance")));
    const rc = await write(`w:${key}`, {
      address: jar,
      abi: arcJarAbi,
      functionName: "withdraw",
      args: [BigInt(id), amount === bal ? MAX_U256 : amount, account!],
    });
    if (rc) withdrawInputs[key] = "";
    return load();
  }
  if (act === "create") {
    const configs = drafts.map((d) => ({
      name: toHex(d.name.trim(), { size: 32 }),
      bps: bpsOf(d),
      unlockAt: d.lock ? BigInt(Math.floor(Date.parse(d.lock + "T00:00:00") / 1000)) : 0n,
      dest: (d.dest.trim() ? getAddress(d.dest.trim()) : ZERO) as Address,
    }));
    const salt = keccak256(toHex(`${Date.now()}-${crypto.getRandomValues(new Uint32Array(4)).join("")}`));
    const rc = await write("create", { address: net.factory as Address, abi: factoryAbi, functionName: "createJar", args: [salt, configs] });
    if (rc) {
      let jar: Address | undefined;
      for (const log of rc.logs) {
        try {
          const ev = decodeEventLog({ abi: factoryAbi, data: log.data, topics: log.topics });
          if (ev.eventName === "JarCreated") jar = (ev.args as { jar: Address }).jar;
        } catch {
          /* not ours */
        }
      }
      drafts = [];
      watch = undefined;
      location.hash = "#/";
      await load();
      toast("ok", `${esc(t("created"))}${jar ? ` <a href="#/pay/${jar}">${t("sharePay")} →</a>` : ""}`, 15000);
    } else render();
  }
});

app.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.d !== undefined && el.dataset.k) {
    const i = Number(el.dataset.d);
    (drafts[i] as unknown as Record<string, string>)[el.dataset.k] = el.value;
    // live-update the summary and this row's errors without re-rendering (keeps focus)
    const s = createSummary();
    const sum = document.getElementById("summary");
    if (sum) sum.innerHTML = s.html;
    const btn = app.querySelector<HTMLButtonElement>('[data-act="create"]');
    if (btn) btn.disabled = !s.ok || !!busy;
    const row = el.closest(".draft");
    if (row) {
      const errs = draftErrors(drafts[i]);
      let p = row.querySelector<HTMLElement>("p.err");
      if (errs.length) {
        if (!p) {
          p = document.createElement("p");
          p.className = "err full";
          row.appendChild(p);
        }
        p.textContent = errs.map((k) => t(k)).join(" ");
      } else p?.remove();
    }
    return;
  }
  if (el.classList.contains("wamt") && el.dataset.key) {
    withdrawInputs[el.dataset.key] = el.value;
    return;
  }
  if (el.form?.dataset.form === "pay") {
    if (el.name === "amount") payAmount = el.value;
    if (el.name === "memo") payMemo = el.value;
    const errEl = document.getElementById("payerr");
    if (errEl) {
      const v = payAmount ? payValidation() : "";
      errEl.textContent = v ? t(v) : "";
    }
    const btn = document.getElementById("paybtn");
    if (btn && account && !busy)
      btn.textContent = AMOUNT_RE.test(payAmount.trim()) ? t("payBtnAmt").replace("{a}", payAmount.trim()) : t("payBtn");
    updateQr();
  }
});

app.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  if (form.dataset.form === "watch") {
    const w = String(new FormData(form).get("w") ?? "").trim();
    if (!isAddress(w)) return toast("err", esc(t("vDest")));
    watch = getAddress(w);
    return load();
  }
  if (form.dataset.form === "pay" && pay) {
    if (!wallet || !account) {
      if (!(await connect())) return;
      return render();
    }
    const v = payValidation();
    if (v) {
      const errEl = document.getElementById("payerr");
      if (errEl) errEl.textContent = t(v);
      return;
    }
    const amount = payAmount.trim();
    const memo = payMemo.trim();
    busy = "pay";
    render();
    try {
      await ensureChain();
      let hash: Hex;
      if (!memo) {
        // Native send: receive() splits it in this same transaction.
        hash = await wallet.sendTransaction({ account, chain: net.chain, to: pay.jar, value: parseUnits(amount, 18) });
      } else {
        // ERC-20 transfer (6 decimals) routed through Arc's Memo contract; swept afterwards.
        const inner = encodeFunctionData({
          abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
          functionName: "transfer",
          args: [pay.jar, parseUnits(amount, 6)],
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
      toast("info", `${esc(t("sent"))} · <a href="${explorerTx(net, hash)}" target="_blank" rel="noopener">${short(hash)}</a>`, 30000);
      const rc = await pub.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(t("errReverted"));
      if (memo) {
        // A call to an address without code "succeeds" silently; make sure USDC really moved.
        const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
        const to = pay.jar.toLowerCase().slice(2);
        if (!rc.logs.some((l) => l.topics[0] === TRANSFER && l.topics[2]?.toLowerCase().endsWith(to))) throw new Error(t("errNoTransfer"));
      }
      toastEl.hidden = true;
      pay.done = { hash, memo: !!memo, amount };
    } catch (err) {
      toast("err", friendly(err), 10000);
    } finally {
      busy = "";
    }
    render();
    refreshPayBalance();
  }
});

window.addEventListener("hashchange", onRoute);
setInterval(() => {
  app.querySelectorAll<HTMLElement>("[data-unlock]").forEach((el) => {
    const cd = countdown(Number(el.dataset.unlock));
    const b = el.querySelector("b");
    if (b && cd) b.textContent = cd;
  });
}, 1000);
eth?.on?.("accountsChanged", () => {
  if (wallet) connect();
});

onRoute();
load();
