// Headless UI end-to-end test against a local demo chain (scripts/demo_local.sh) with an injected
// test wallet backed by arc-anvil dev accounts. Needs: npm i --no-save puppeteer-core, Chrome,
// and the app built with VITE_FACTORY_LOCAL and served at APP_URL (default http://localhost:5173/index.html).
import puppeteer from "puppeteer-core";
const BASE = (process.env.APP_URL ?? "http://localhost:5173/index.html") + "?net=local&lang=en";
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const [OWNER, PAYER] = ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true, protocolTimeout: 30000 });
const results = [];
const ok = (name, cond) => { results.push(`${cond ? "PASS" : "FAIL"} ${name}`); };
async function page(acct, url) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1200, height: 1000 });
  p.on("pageerror", (e) => results.push("PAGEERROR " + e.message));
  await p.evaluateOnNewDocument((acct, RPC) => {
    let id = 0;
    const rpc = async (method, params) => {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }).then((r) => r.json());
      if (r.error) { const e = new Error(r.error.message); e.code = r.error.code; e.data = r.error.data; throw e; }
      return r.result;
    };
    window.ethereum = {
      on() {},
      async request({ method, params }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [acct];
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "eth_sendTransaction") params = [{ ...params[0], from: acct }];
        return rpc(method, params ?? []);
      },
    };
  }, acct, RPC);
  await p.goto(url, { waitUntil: "networkidle0" });
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function setVal(p, sel, v) { await sleep(300); const el = await p.waitForSelector(sel); await el.click({ clickCount: 3 }); await p.keyboard.press("Backspace"); await p.type(sel, v); }
const text = (p) => p.evaluate(() => document.body.innerText);
const waitText = (p, s, timeout = 15000) => p.waitForFunction((s) => document.body.innerText.includes(s), { timeout }, s).then(() => true).catch(() => false);

// 1. owner connects and creates a jar
const o = await page(OWNER, BASE + "#/create");
await o.click('[data-act="connect"]');
ok("connect shows account", await waitText(o, "0xf39F"));
// validation: long Chinese name
await setVal(o, 'input[data-k="name"]', "这是一个非常非常长的罐子名称超过三十一个字节");
ok("long UTF-8 name rejected", await waitText(o, "Name is too long"));
ok("create disabled on error", await o.$eval('[data-act="create"]', (b) => b.disabled));
await setVal(o, 'input[data-k="name"]', "税款");
await setVal(o, 'input[data-k="pct"]', "99");
ok("over-100% total rejected", await waitText(o, "more than 100%"));
await setVal(o, 'input[data-k="pct"]', "25");
ok("create enabled again", !(await o.$eval('[data-act="create"]', (b) => b.disabled)));
await o.click('[data-act="create"]');
ok("jar created toast", await waitText(o, "Your jar is live", 20000));
ok("dashboard shows new jar 税款", await waitText(o, "税款"));
const jarAddr = await o.$eval('a.button[href^="#/pay/"]', (a) => a.getAttribute("href").slice(6));

// 2. payer pays 100 USDC natively via pay page
const p = await page(PAYER, `${BASE}&amount=100#/pay/${jarAddr}`);
ok("pay page verified", await waitText(p, "Verified ArcJar"));
await p.click("#paybtn"); // connect
await waitText(p, "Your balance");
ok("pay button shows amount", (await p.$eval("#paybtn", (b) => b.textContent)).includes("Pay 100 USDC"));
await p.click("#paybtn");
ok("payment success state", await waitText(p, "Payment sent", 20000));
ok("split confirmed copy", (await text(p)).includes("already been split"));


// bad amount
await p.click('[data-act="payagain"]');
await setVal(p, 'input[name="amount"]', "1.1234567");
ok("7-decimal amount rejected", await waitText(p, "up to 6 decimals"));

// 3. owner sees balances, withdraws from Spendable, Tax locked
await p.close();
await o.bringToFront();
await o.reload({ waitUntil: "networkidle0" });
await o.click('[data-act="connect"]');
await waitText(o, "69.86");
const t0 = await text(o);
ok("Spendable 69.86 after 100 USDC", t0.includes("69.86"));
ok("Tax 24.95", t0.includes("24.95"));
ok("Tax withdraw disabled (locked)", await o.$eval(`[data-act="withdraw"][data-jar="${jarAddr}"][data-id="1"]`, (b) => b.disabled));
await setVal(o, `input.wamt[data-key="${jarAddr}:0"]`, "10");
await o.click(`[data-act="withdraw"][data-jar="${jarAddr}"][data-id="0"]`);
ok("withdraw confirmed", await waitText(o, "Confirmed", 20000));
ok("Spendable now 59.86", await waitText(o, "59.86"));
// over-withdraw is caught client-side
await setVal(o, `input.wamt[data-key="${jarAddr}:0"]`, "1000");
await o.click(`[data-act="withdraw"][data-jar="${jarAddr}"][data-id="0"]`);
ok("over-withdraw friendly error", await waitText(o, "more than this jar holds"));

// 4. memo pay on a chain without the Memo contract -> friendly error, no crash
await o.close();
const p2 = await page(PAYER, `${BASE}&amount=1&memo=INV-1#/pay/${jarAddr}`);
await waitText(p2, "Verified ArcJar");
await p2.click("#paybtn"); await waitText(p2, "Your balance");
await p2.click("#paybtn");
await new Promise((r) => setTimeout(r, 4000));
const t2 = await text(p2);
ok("memo w/o Memo contract is NOT reported as paid", !t2.includes("Payment sent") && t2.includes("no USDC reached"));
results.push("memo-path text: " + (t2.match(/(Payment sent[^\n]*|The transaction[^\n]*|Submitted[^\n]*)/)?.[0] ?? t2.slice(-300).replace(/\n/g, " | ")));

// 5. unverified + not-created states
await p2.close();
const p3 = await page(PAYER, `${BASE}#/pay/0x000000000000000000000000000000000000dEaD`);
ok("not-created warning", await waitText(p3, "Not created yet"));
const p4 = await page(PAYER, `${BASE}#/pay/0x3600000000000000000000000000000000000000`);
ok("non-ArcJar contract flagged", await waitText(p4, "Not an ArcJar"));
// 6. XSS via factory param is inert + custom factory banner shown
const p5 = await page(PAYER, `${process.env.APP_URL ?? "http://localhost:5173/index.html"}?net=local&factory=%22%3E%3Cimg%20src%3Dx%20onerror%3Dwindow.pwned%3D1%3E`);
ok("custom factory banner", await waitText(p5, "custom factory"));
ok("no XSS", !(await p5.evaluate(() => window.pwned)));
console.log(results.join("\n"));
await browser.close();
if (results.some((r) => !r.startsWith("PASS") && !r.startsWith("memo-path"))) process.exit(1);
