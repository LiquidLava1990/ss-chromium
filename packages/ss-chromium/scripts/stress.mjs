// Session stress harness: the packaged runtime, real Chromium, real input and file transfers.
// Playwright observes results and injects faults; ALL normal controls use MCP.
//
//   pnpm build && node packages/ss-chromium/scripts/stress.mjs [rounds] [--crash-probe|--resume-probe|--popup-probe]
//
// Settings (all optional):
//   SS_STRESS_OUT            where runs and reports go (default: <tmp>/ss-chromium-stress)
//   SS_STRESS_HEADLESS=1     headless browser
//   SS_STRESS_STORAGE_GUARD  a PowerShell script run before and after (for example a disk-budget check)
//   SS_STRESS_PUBLIC_WEB=0   skip the two public-web page loads at the end
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { extensionIdForKey } from "../lib/session.mjs";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cli = path.join(packageRoot, "bin", "ss-chromium.mjs");
const root = path.resolve(
  process.env.SS_STRESS_OUT || path.join(tmpdir(), "ss-chromium-stress"),
);
const storageGuard = process.env.SS_STRESS_STORAGE_GUARD || "";
function enforceTestStorageBudget() {
  if (
    process.platform === "win32" &&
    storageGuard &&
    existsSync(storageGuard)
  ) {
    execFileSync("powershell.exe", ["-NoProfile", "-File", storageGuard], {
      stdio: "inherit",
      windowsHide: true,
    });
  }
}
enforceTestStorageBudget();
const rounds = Number(process.argv[2] || 25);
const startRound = process.argv.includes("--crash-probe") ? 5 : 1;
const resumeProbe = process.argv.includes("--resume-probe");
const popupProbe = process.argv.includes("--popup-probe");
assert.ok(!(resumeProbe && popupProbe), "Use one focused probe at a time");
const planned = popupProbe
  ? 18
  : (rounds - startRound + 1) * 20 + (resumeProbe ? 7 : 0);
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 100);
const out = path.join(root, `session-stress-${Date.now()}`);
mkdirSync(out, { recursive: true });
const sessions = [];
const results = [];
const publicWeb = [];
const startedAt = new Date().toISOString();
const requests = [];
let idpAccountsEmpty = false;
const fixture = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Cache-Control", "no-store");
  const idp = `http://localhost:${fixture.address().port}`;
  if (
    url.pathname === "/.well-known/web-identity" ||
    url.pathname.startsWith("/idp/")
  ) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      req.headers.origin || `http://127.0.0.1:${fixture.address().port}`,
    );
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Content-Type", "application/json");
    const endpoints = {
      "/.well-known/web-identity": {
        provider_urls: [`${idp}/idp/config.json`],
      },
      "/idp/config.json": {
        accounts_endpoint: "/idp/accounts",
        client_metadata_endpoint: "/idp/metadata",
        id_assertion_endpoint: "/idp/token",
        login_url: "/idp/login",
      },
      "/idp/metadata": {
        privacy_policy_url: `${idp}/privacy`,
        terms_of_service_url: `${idp}/terms`,
      },
      "/idp/accounts": {
        accounts: (idpAccountsEmpty ? [] : [0, 1]).map((index) => ({
          id: `account-${index}`,
          email: `fixture-${index}@example.test`,
          name: `Fixture ${index}`,
          given_name: `Fixture ${index}`,
          approved_clients: ["ss-native-test"],
        })),
      },
    };
    if (endpoints[url.pathname]) {
      res.end(JSON.stringify(endpoints[url.pathname]));
      return;
    }
    if (url.pathname === "/idp/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push({ nativeSignIn: body });
      res.end(
        JSON.stringify({
          token: `local-fixture:${new URLSearchParams(body).get("account_id")}`,
        }),
      );
      return;
    }
    if (url.pathname === "/idp/login") {
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Set-Login", "logged-in");
      res.setHeader(
        "Set-Cookie",
        "idp_fixture=existing-login; HttpOnly; SameSite=Lax; Path=/",
      );
      res.end(
        '<title>Fixture identity provider</title>Existing fixture account<script>navigator.login?.setStatus("logged-in").then(()=>{try{IdentityProvider.close()}catch{}}).catch(()=>{})</script>',
      );
      return;
    }
    if (url.pathname === "/idp/logout") {
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Set-Login", "logged-out");
      res.end(
        '<title>Fixture provider logged out</title><script>navigator.login?.setStatus("logged-out").catch(()=>{})</script>',
      );
      return;
    }
    res.writeHead(404);
    res.end("{}");
    return;
  }
  if (url.pathname === "/cookie") {
    const value = url.searchParams.get("value");
    res.setHeader(
      "Set-Cookie",
      `ss_login=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`,
    );
    res.end(value);
    return;
  }
  if (url.pathname === "/event") {
    requests.push(Object.fromEntries(url.searchParams));
    res.end("ok");
    return;
  }
  if (url.pathname === "/submit") {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ submitted: url.searchParams.get("session"), body });
    res.end("Saved local application");
    return;
  }
  if (url.pathname === "/report.csv") {
    res.setHeader("Content-Type", "text/csv");
    res.end(`name,round\nSS Chromium,${url.searchParams.get("round")}\n`);
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const who = url.searchParams.get("session") || "unknown";
  if (url.pathname === "/popup-flow") {
    const kind = url.searchParams.get("kind");
    const stage = url.searchParams.get("stage") || "initial";
    res.end(`<!doctype html><title>Popup ${who} ${kind} ${stage}</title>
      <label>Popup answer<input id="popup-answer"></label><button id="popup-click">Popup action</button>
      <button id="nested">Nested popup</button><button id="redirect">Cross-origin redirect</button>
      <button id="finish">Finish and close</button><output id="popup-proof"></output>
      <script>
        window.popupProof={clicks:0,trusted:false};
        document.querySelector('#popup-click').onclick=e=>{popupProof.clicks++;popupProof.trusted=e.isTrusted};
        document.querySelector('#nested').onclick=()=>window.open('/popup-flow?session=${who}&kind=nested','_blank','width=460,height=420');
        document.querySelector('#redirect').onclick=()=>location.href='http://localhost:${fixture.address().port}/popup-flow?session=${who}&kind=${kind}&stage=redirect';
        document.querySelector('#finish').onclick=()=>{if(opener)opener.postMessage({type:'ss-popup',kind:'${kind}'},'*');window.close()};
      </script>`);
    return;
  }
  if (url.pathname === "/child") {
    res.end(
      `<button id="frame" onclick="fetch('/event?frame=${who}&trusted='+event.isTrusted)">Frame action</button>`,
    );
    return;
  }
  if (url.pathname === "/popup" || url.pathname === "/second") {
    res.end(
      `<title>${who} ${url.pathname}</title><h1>${who} ${url.pathname}</h1>`,
    );
    return;
  }
  res.end(`<!doctype html><meta charset="utf-8"><title>Workspace ${who}</title>
    <style>body{font:16px sans-serif;margin:20px}button,input,select{padding:8px;font:inherit}#drag,#drop{display:inline-block;width:160px;height:50px;background:#fdc;margin:10px}#pane{height:90px;overflow:auto;border:1px solid;width:500px}iframe{height:60px}#notes{border:1px solid;min-height:30px}</style>
    <h1>Local application workspace ${who}</h1>
    <label>Full name<input id="name"></label><button id="click">Click action</button><button id="login">Sign in fixture</button><output id="signed-in"></output>
    <div id="external-drop" style="width:300px;height:100px;border:1px solid">Drop documents here</div>
    <button id="alert">Open alert</button><button id="confirm">Open confirm</button><button id="prompt">Open prompt</button>
    <button id="fedcm">Continue with fixture identity</button>
    <label><input type="checkbox" id="check">Consent fixture</label>
    <select id="country"><option value="us">United States</option><option value="ca">Canada</option></select>
    <div id="shadow"></div><button id="show-late">Load next step</button><div id="late"></div>
    <div><div id="drag">Drag document</div><div id="drop">Drop document</div></div>
    <div id="pane"><div style="height:1500px">Scrollable job list</div></div>
    <iframe src="http://localhost:${fixture.address().port}/child?session=${who}"></iframe>
    <input type="file" id="upload" multiple hidden><output id="uploaded"></output>
    <div id="notes" contenteditable="true" aria-label="Cover letter"></div>
    <a id="popup" target="_blank" href="/popup?session=${who}">Open account popup</a>
    ${["feature", "named", "blank", "noopener", "cross", "dual", "worker"].map((kind) => `<button id="open-${kind}">Open ${kind} window</button>`).join("")}
    <a id="download" href="/report.csv?round=0">Download report</a>
    <form id="form"><input name="answer" id="answer" value="confirmed"><button id="submit">Submit local application</button></form>
    <output id="saved"></output><div style="height:1000px">Page scroll area</div>
    <script>
      window.proof={clicks:0,trusted:false,shadow:0,drag:0,dragTrusted:false};
      proof.messages=0;
      proof.drops=[];
      document.querySelector('#fedcm').onclick=()=>{window.fedResult=null;window.fedError=null;navigator.credentials.get({identity:{providers:[{configURL:'${idp}/idp/config.json',clientId:'ss-native-test'}],mode:window.fedMode||'active'},mediation:'required'}).then(value=>{window.fedResult=value.token}).catch(error=>{window.fedError=error.message})};
      document.querySelector('#external-drop').ondragover=e=>e.preventDefault();
      document.querySelector('#external-drop').ondrop=async e=>{e.preventDefault();const text=e.dataTransfer.getData('text/plain');const files=await Promise.all([...e.dataTransfer.files].map(async f=>({name:f.name,text:await f.text()})));proof.drops.push({files,text,trusted:e.isTrusted})};
      document.querySelector('#alert').onclick=()=>{alert('Fixture alert');proof.alertDone=true};
      document.querySelector('#confirm').onclick=()=>{proof.confirmResult=confirm('Fixture confirmation')};
      document.querySelector('#prompt').onclick=()=>{proof.promptResult=prompt('Fixture prompt')};
      addEventListener('message',e=>{if(e.data?.type==='ss-popup'){proof.messages++;proof.lastPopup=e.data.kind}});
      for(const kind of ['feature','named','blank','noopener','cross','dual','worker']) {
        document.querySelector('#open-'+kind).onclick=()=>{
          const target='/popup-flow?session=${who}&kind='+kind;
          const features='width=460,height=420'+(kind==='noopener'?',noopener':'');
          const child=window.open(kind==='blank'?'about:blank':target,kind==='named'?'ss-named-${who}':'_blank',features);
          if(kind==='blank')setTimeout(()=>child.location=target,150);
        };
      }
      document.querySelector('#login').onclick=async()=>{const value='login-'+new URL(location.href).searchParams.get('round');const result=await fetch('/cookie?value='+value);localStorage.setItem('session',value);document.querySelector('#signed-in').textContent=await result.text()};
      document.querySelector('#click').onclick=e=>{proof.clicks++;proof.trusted=e.isTrusted};
      const shadow=document.querySelector('#shadow').attachShadow({mode:'open'});
      shadow.innerHTML='<button id="shadow-click">Shadow action</button>';
      shadow.querySelector('button').onclick=e=>{proof.shadow++;proof.shadowTrusted=e.isTrusted};
      document.querySelector('#show-late').onclick=()=>setTimeout(()=>{document.querySelector('#late').innerHTML='<button id="delayed">Delayed action</button>';document.querySelector('#delayed').onclick=e=>{proof.delayed=e.isTrusted}},300);
      let down=false;
      document.querySelector('#drag').onpointerdown=e=>{down=e.isTrusted};
      document.addEventListener('pointerup',e=>{const b=document.querySelector('#drop').getBoundingClientRect();if(down&&e.clientX>=b.left&&e.clientX<=b.right&&e.clientY>=b.top&&e.clientY<=b.bottom){proof.drag++;proof.dragTrusted=e.isTrusted}down=false});
      document.querySelector('#upload').onchange=async e=>{document.querySelector('#uploaded').textContent=JSON.stringify(await Promise.all([...e.target.files].map(async f=>({name:f.name,text:await f.text()}))))};
      document.querySelector('#form').onsubmit=async e=>{e.preventDefault();const result=await fetch('/submit?session=${who}',{method:'POST',body:new URLSearchParams(new FormData(e.target))});document.querySelector('#saved').textContent=await result.text()};
      document.querySelector('#download').href='/report.csv?round='+new URL(location.href).searchParams.get('round');
    </script>`);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${fixture.address().port}`;
const idp = `http://localhost:${fixture.address().port}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The runtime's state for this run: daemon home, relay port and the live browser host
function receipt(s) {
  const home = path.join(s.state, "daemon");
  const { port } = JSON.parse(
    readFileSync(path.join(home, "bridge.json"), "utf8"),
  );
  const live = JSON.parse(
    readFileSync(path.join(home, "browser-host.json"), "utf8"),
  );
  const extension = path.join(s.state, "extension");
  const { key } = JSON.parse(
    readFileSync(path.join(extension, "manifest.json"), "utf8"),
  );
  const { publicKey } = JSON.parse(
    readFileSync(path.join(home, "identity.json"), "utf8"),
  );
  return {
    // Per MCP server: the conversation scope and the server process
    id: s.key,
    ownerPid: s.serverPid,
    // Shared by every conversation: daemon, profile, extension and browser
    home,
    port,
    profile: path.join(s.state, "profile"),
    extension,
    extensionId: extensionIdForKey(key),
    signerFingerprint: createHash("sha256").update(publicKey).digest("hex"),
    browserPid: live.browserPid,
    hostPid: live.hostPid,
    debugPort: live.debugPort,
  };
}
async function bounded(label, fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      error = e;
    }
    await pause(100);
  }
  throw new Error(`${label} timed out: ${error?.message || "condition false"}`);
}
async function raw(s, commands) {
  const result = await s.client.callTool(
    {
      name: "browser",
      arguments: {
        commands,
        ...(s.explicitKey ? { session_key: s.explicitKey } : {}),
      },
    },
    undefined,
    { timeout: 90000 },
  );
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  s.last = { commands, text };
  return { result, text };
}
async function call(s, commands) {
  const { result, text } = await raw(s, commands);
  assert.ok(!result.isError, text);
  return text;
}
async function ready(s) {
  return bounded(`${s.name} browser ready`, async () => {
    const r = await raw(s, "tab list");
    return !r.result.isError && r.text;
  });
}
async function observe(s) {
  const meta = receipt(s);
  s.browser = await bounded("observer connect", () =>
    chromium.connectOverCDP(`http://127.0.0.1:${meta.debugPort}`, {
      timeout: 8000,
    }),
  );
  s.context = s.browser.contexts()[0];
  // An observer must not auto-dismiss dialogs before the controlling MCP
  // connection can handle them. Both observers share this browser profile.
  s.context.on("dialog", () => {});
  return meta;
}
function page(s) {
  const p = s.context
    .pages()
    .filter((p) => p.url().startsWith(`${base}/?session=${s.name}`))
    .at(-1);
  assert.ok(p, `${s.name} main page exists`);
  return p;
}
async function connectSession(s, mode = "thread") {
  s.explicitKey = mode === "explicit" ? s.key : undefined;
  // Identical client names must still produce separate session scopes/windows.
  s.client = new Client({ name: "codex-mcp-client", version: "1.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    stderr: "pipe",
    cwd: out,
    env: {
      ...process.env,
      SS_CHROMIUM_CONVERSATION_KEY: mode === "env" ? s.key : "",
      CODEX_THREAD_ID: mode === "thread" ? s.key.slice(6) : "",
      SS_CHROMIUM_HEADLESS: process.env.SS_STRESS_HEADLESS === "1" ? "1" : "0",
      SS_CHROMIUM_HOME: s.state,
    },
  });
  await s.client.connect(transport);
  s.serverPid = transport.pid;
  await ready(s);
}
async function newSession(name) {
  const s = {
    name,
    key: `codex:${randomUUID()}`,
    state: path.join(out, "runtime"),
  };
  sessions.push(s);
  await connectSession(s);
  await observe(s);
  await call(s, `goto ${base}/?session=${name}&round=initial`);
  const main = Number(/^\* (\d+)/m.exec(await call(s, "tab list"))?.[1]);
  await call(
    s,
    `tab new ${base}/second?session=${name}&persist=1\ntab select ${main}`,
  );
  return s;
}
function persist() {
  const report = {
    startedAt,
    updatedAt: new Date().toISOString(),
    planned,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    realBrowser:
      "Installed unbranded Chromium; production SS extension; MCP controls; independent DOM/HTTP/file verification",
    publicWeb,
    limitations: [
      "A hard kill can lose cookies/local storage not yet flushed to disk and unsaved form data. Recent-cookie and local-storage durability are recorded separately in each fault result; live sharing and reconnect persistence are asserted.",
    ],
    results,
  };
  writeFileSync(
    path.join(out, "results.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}
async function test(round, name, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({
      round,
      name,
      ok: true,
      ms: Date.now() - start,
      ...(detail ? { detail } : {}),
    });
  } catch (error) {
    results.push({
      round,
      name,
      ok: false,
      ms: Date.now() - start,
      error: error.stack,
      lastCalls: sessions.map((s) => ({ name: s.name, last: s.last })),
    });
    for (const s of sessions)
      await s.context
        ?.pages()[0]
        ?.screenshot({
          path: path.join(out, `failure-${s.name}.png`),
          timeout: 3000,
        })
        .catch(() => {});
    persist();
    throw error;
  }
  persist();
}
try {
  const a = await newSession("ALPHA");
  const b = await newSession("BETA");
  const ma = receipt(a),
    mb = receipt(b);
  for (const key of ["id", "ownerPid"])
    assert.notEqual(ma[key], mb[key], `independent ${key}`);
  for (const key of [
    "home",
    "profile",
    "extension",
    "port",
    "browserPid",
    "signerFingerprint",
  ])
    assert.equal(ma[key], mb[key], `shared ${key}`);
  console.log(
    JSON.stringify({
      started: true,
      out,
      planned,
      isolation:
        "shared login profile; distinct MCP scopes and browser windows",
    }),
  );
  for (let i = startRound; i <= (popupProbe ? 0 : rounds); i++) {
    const s = i % 2 ? a : b;
    const other = s === a ? b : a;
    const mainUrl = `${base}/?session=${s.name}&round=${i}`;
    await test(i, "navigate and inspect real page", async () => {
      const text = await call(s, `goto ${mainUrl}\nget title\nsnapshot -i`);
      assert.match(text, new RegExp(`Workspace ${s.name}`));
      assert.equal(await page(s).title(), `Workspace ${s.name}`);
    });
    await test(i, "Unicode and quoted form values", async () => {
      const value = `Ada résumé ${i} — 'quoted' 中文 \\ paths`;
      await call(s, `fill getByLabel('Full name') ${JSON.stringify(value)}`);
      assert.equal(await page(s).locator("#name").inputValue(), value);
    });
    await test(i, "trusted pointer click exactly once", async () => {
      await call(s, "click '#click'");
      assert.deepEqual(
        await page(s).evaluate(() => [
          window.proof.clicks,
          window.proof.trusted,
        ]),
        [1, true],
      );
    });
    await test(i, "checkbox on and off", async () => {
      await call(s, "check '#check'");
      assert.equal(await page(s).locator("#check").isChecked(), true);
      await call(s, "uncheck '#check'");
      assert.equal(await page(s).locator("#check").isChecked(), false);
    });
    await test(i, "native dropdown selection", async () => {
      await call(s, "select '#country' \"ca\"");
      assert.equal(await page(s).locator("#country").inputValue(), "ca");
    });
    await test(i, "shadow DOM trusted click", async () => {
      await call(s, "click '#shadow-click'");
      assert.deepEqual(
        await page(s).evaluate(() => [
          window.proof.shadow,
          window.proof.shadowTrusted,
        ]),
        [1, true],
      );
    });
    await test(i, "cross-origin iframe trusted input", async () => {
      const count = requests.filter((e) => e.frame === s.name).length;
      await call(
        s,
        "click frameLocator('iframe').getByRole('button', { name: 'Frame action' })",
      );
      await bounded(
        "frame event",
        () => requests.filter((e) => e.frame === s.name).length === count + 1,
      );
      assert.equal(
        requests.filter((e) => e.frame === s.name).at(-1).trusted,
        "true",
      );
    });
    await test(i, "asynchronously rendered control", async () => {
      await call(s, "click '#show-late'\nclick '#delayed'");
      assert.equal(await page(s).evaluate(() => window.proof.delayed), true);
    });
    await test(i, "trusted pointer drag and drop", async () => {
      await call(s, "drag '#drag' '#drop'");
      assert.deepEqual(
        await page(s).evaluate(() => [
          window.proof.drag,
          window.proof.dragTrusted,
        ]),
        [1, true],
      );
    });
    await test(i, "nested scrolling to both limits", async () => {
      await call(s, "scroll bottom --in '#pane'");
      assert.ok(
        await page(s)
          .locator("#pane")
          .evaluate((el) => el.scrollTop > 1000),
      );
      await call(s, "scroll top --in '#pane'");
      assert.equal(
        await page(s)
          .locator("#pane")
          .evaluate((el) => el.scrollTop),
        0,
      );
    });
    await test(
      i,
      "document upload with spaces and Unicode filename",
      async () => {
        const filename = `résumé document ${i}.txt`;
        const file = path.join(out, filename);
        const text = `Approved fixture résumé ${i}\nVerified full contents`;
        writeFileSync(file, text);
        await call(s, `upload '#upload' ${JSON.stringify(file)}`);
        await bounded("upload contents", async () =>
          (await page(s).locator("#uploaded").textContent()).includes(
            "Verified full contents",
          ),
        );
        assert.deepEqual(
          JSON.parse(await page(s).locator("#uploaded").textContent()),
          [{ name: filename, text }],
        );
      },
    );
    await test(i, "contenteditable cover letter", async () => {
      const text = `Local cover letter ${i} — precise content`;
      await call(s, `fill getByLabel('Cover letter') ${JSON.stringify(text)}`);
      assert.equal(await page(s).locator("#notes").textContent(), text);
    });
    await test(i, "keyboard focus and replacement", async () => {
      await call(s, `click '#name'\npress Control+a\ntype "Keyboard ${i}"`);
      assert.equal(
        await page(s).locator("#name").inputValue(),
        `Keyboard ${i}`,
      );
    });
    await test(
      i,
      "popup discovery and original form preservation",
      async () => {
        const main = Number(/^\* (\d+)/m.exec(await call(s, "tab list"))?.[1]);
        assert.ok(main);
        await call(s, "click '#popup'");
        const listing = await call(s, "tab list");
        const popup = Number(
          new RegExp(`^[* ] (\\d+) "${s.name} /popup`, "m").exec(listing)?.[1],
        );
        assert.ok(popup, listing);
        await call(
          s,
          `tab select ${popup}\nget title\ntab close ${popup}\ntab select ${main}`,
        );
        assert.equal(
          await page(s).locator("#name").inputValue(),
          `Keyboard ${i}`,
        );
      },
    );
    await test(i, "new tab selection and closure", async () => {
      const main = Number(/^\* (\d+)/m.exec(await call(s, "tab list"))?.[1]);
      await call(s, `tab new ${base}/second?session=${s.name}`);
      const second = Number(/^\* (\d+)/m.exec(await call(s, "tab list"))?.[1]);
      assert.ok(second && second !== main);
      const text = await call(
        s,
        `get title\ntab close ${second}\ntab select ${main}`,
      );
      assert.match(text, /\/second/);
      assert.equal(page(s).url(), mainUrl);
    });
    await test(i, "download verified on disk", async () => {
      const file = path.join(out, `report-${i}.csv`);
      await call(s, `download '#download' --path ${JSON.stringify(file)}`);
      assert.equal(
        readFileSync(file, "utf8"),
        `name,round\nSS Chromium,${i}\n`,
      );
    });
    await test(i, "local application submission exactly once", async () => {
      const count = requests.filter((e) => e.submitted === s.name).length;
      await call(s, `fill '#answer' "Answer ${i}"\nclick '#submit'`);
      await bounded(
        "saved application",
        async () =>
          (await page(s).locator("#saved").textContent()) ===
          "Saved local application",
      );
      const sent = requests.filter((e) => e.submitted === s.name);
      assert.equal(sent.length, count + 1);
      assert.equal(sent.at(-1).body, `answer=Answer+${i}`);
    });
    await test(i, "history back forward and reload", async () => {
      await call(s, `goto ${base}/second?session=${s.name}\nback`);
      assert.equal(page(s).url(), mainUrl);
      await call(s, "forward\nreload");
      assert.ok(
        s.context
          .pages()
          .some((p) => p.url() === `${base}/second?session=${s.name}`),
      );
      await call(s, "back");
    });
    await test(
      i,
      "shared login cookies with session-isolated windows and tabs",
      async () => {
        await call(s, "click '#login'");
        await bounded(
          "fixture login saved",
          async () =>
            (await page(s).locator("#signed-in").textContent()) ===
            `login-${i}`,
        );
        const expected = `login-${i}`;
        const worker = s.context
          .serviceWorkers()
          .filter((w) => w.url().includes(receipt(s).extensionId))
          .at(-1);
        assert.ok(worker);
        const windows = await worker.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          return tabs
            .filter((t) => t.url.includes("session="))
            .map((t) => ({ url: t.url, windowId: t.windowId }));
        });
        const wa = windows.find((t) => t.url.includes(`session=${s.name}`));
        const wb = windows.find((t) => t.url.includes(`session=${other.name}`));
        assert.ok(wa && wb);
        assert.notEqual(
          wa.windowId,
          wb.windowId,
          "separate real browser windows",
        );
        for (const current of [s, other]) {
          const text = await call(current, "tab list");
          const foreign = current === s ? other : s;
          assert.ok(text.includes(`session=${current.name}`));
          assert.ok(!text.includes(`session=${foreign.name}`), text);
          assert.equal(
            await page(current).evaluate(() => localStorage.getItem("session")),
            expected,
          );
          const cookies = await current.context.cookies(base);
          assert.equal(
            cookies.find((c) => c.name === "ss_login")?.value,
            expected,
          );
          assert.equal(
            cookies.find((c) => c.name === "ss_login")?.httpOnly,
            true,
          );
          const foreignId = Number(
            /^\* (\d+)/m.exec(await call(foreign, "tab list"))?.[1],
          );
          assert.ok(foreignId);
          assert.ok(
            (await raw(current, `tab select ${foreignId}`)).result.isError,
            "foreign tab selection refused",
          );
        }
      },
    );
    await test(
      i,
      "fault injection and recovery without cross-session attachment",
      async () => {
        const meta = receipt(s);
        const kind =
          i % 5 === 0
            ? "browser-process-crash"
            : i % 2
              ? "daemon-process-kill"
              : "extension-worker-stop";
        const start = Date.now();
        if (kind === "daemon-process-kill") {
          const file = path.join(meta.home, `daemon-${meta.port}.json`);
          const old = JSON.parse(readFileSync(file, "utf8")).pid;
          process.kill(old);
          await bounded("autonomous daemon restart", () => {
            const now = JSON.parse(readFileSync(file, "utf8")).pid;
            return now !== old && now;
          });
        } else if (kind === "extension-worker-stop") {
          const cdp = await s.browser.newBrowserCDPSession();
          const target = (await cdp.send("Target.getTargets")).targetInfos.find(
            (t) =>
              t.type === "service_worker" && t.url.includes(meta.extensionId),
          );
          assert.ok(target);
          await cdp.send("Target.closeTarget", { targetId: target.targetId });
          await cdp.detach();
        } else {
          process.kill(meta.browserPid);
          await bounded(
            "own browser relaunched",
            () => receipt(s).browserPid !== meta.browserPid,
          );
          await observe(s);
          await observe(other);
        }
        await ready(s);
        const text = await call(s, `goto ${mainUrl}\nget title`);
        assert.match(text, new RegExp(`Workspace ${s.name}`));
        const foreign = await call(other, "tab list");
        assert.ok(foreign.includes("persist=1"), foreign);
        assert.ok((await call(s, "tab list")).includes("persist=1"));
        assert.ok(!foreign.includes(`session=${s.name}`), foreign);
        const otherTitle = await call(other, "get title");
        assert.ok(otherTitle.includes(`Workspace ${other.name}`), otherTitle);
        // Reading a title is not proof that pointer/keyboard input recovered.
        // Verify actual trusted input, file contents, and one local submission
        // immediately after EACH fault, with an independent observer.
        const beforeClicks = await page(s).evaluate(() => window.proof.clicks);
        await call(
          s,
          `click '#click'\nfill '#name' "Replace this after recovery"\nclick '#name'\npress Control+a\ntype "Recovered ${i}"\nclick '#country'\npress Home\npress ArrowDown\npress Enter`,
        );
        assert.deepEqual(
          await page(s).evaluate(() => [
            window.proof.clicks,
            window.proof.trusted,
          ]),
          [beforeClicks + 1, true],
        );
        assert.equal(
          await page(s).locator("#name").inputValue(),
          `Recovered ${i}`,
        );
        assert.equal(await page(s).locator("#country").inputValue(), "ca");
        const recoveryFile = path.join(out, `recovered résumé ${i}.txt`);
        const recoveryContents = `Recovered upload ${i}`;
        writeFileSync(recoveryFile, recoveryContents);
        await call(s, `upload '#upload' ${JSON.stringify(recoveryFile)}`);
        await bounded("recovered upload contents", async () =>
          (await page(s).locator("#uploaded").textContent()).includes(
            recoveryContents,
          ),
        );
        assert.deepEqual(
          JSON.parse(await page(s).locator("#uploaded").textContent()),
          [{ name: path.basename(recoveryFile), text: recoveryContents }],
        );
        const beforeSubmits = requests.filter(
          (e) => e.submitted === s.name,
        ).length;
        await call(
          s,
          `fill '#answer' "Recovered answer ${i}"\nclick '#submit'`,
        );
        await bounded(
          "recovered local submission",
          () =>
            requests.filter((e) => e.submitted === s.name).length ===
            beforeSubmits + 1,
        );
        assert.equal(
          new URLSearchParams(
            requests.filter((e) => e.submitted === s.name).at(-1).body,
          ).get("answer"),
          `Recovered answer ${i}`,
        );
        const recentLocalStorage = await page(s).evaluate(() =>
          localStorage.getItem("session"),
        );
        const recentCookie = (await s.context.cookies(base)).find(
          (c) => c.name === "ss_login",
        );
        // A forced browser kill can lose unflushed native site storage. Keep
        // live/reconnect guarantees strict and report crash durability separately.
        if (kind !== "browser-process-crash") {
          assert.equal(recentLocalStorage, `login-${i}`);
          assert.equal(recentCookie?.value, `login-${i}`);
        }
        return {
          kind,
          recoveryMs: Date.now() - start,
          recentLoginCookieSurvived: recentCookie?.value === `login-${i}`,
          recentLocalStorageSurvived: recentLocalStorage === `login-${i}`,
          recoveredInput: {
            trustedClick: true,
            keyboardReplacement: true,
            keyboardDropdown: true,
            uploadContents: true,
            submissionExactlyOnce: true,
          },
        };
      },
    );
    console.log(
      JSON.stringify({
        round: i,
        passed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      }),
    );
  }
  if (resumeProbe) {
    const tabIds = (listing) =>
      [...listing.matchAll(/^[* ] (\d+) /gm)]
        .map((m) => Number(m[1]))
        .sort((x, y) => x - y);
    await call(a, "fill '#name' \"Resume this exact form\"");
    const originalTabs = tabIds(await call(a, "tab list"));
    const otherTabs = tabIds(await call(b, "tab list"));
    const originalForm = await page(a).locator("#name").inputValue();
    const originalUpload = await page(a).locator("#uploaded").textContent();
    async function assertResumed() {
      assert.deepEqual(tabIds(await call(a, "tab list")), originalTabs);
      assert.deepEqual(tabIds(await call(b, "tab list")), otherTabs);
      assert.equal(await page(a).locator("#name").inputValue(), originalForm);
      assert.equal(
        await page(a).locator("#uploaded").textContent(),
        originalUpload,
      );
      const worker = a.context
        .serviceWorkers()
        .filter((w) => w.url().includes(receipt(a).extensionId))
        .at(-1);
      const tabs = await worker.evaluate(async () =>
        (await chrome.tabs.query({})).map((t) => ({
          id: t.id,
          windowId: t.windowId,
        })),
      );
      assert.equal(
        new Set(
          tabs
            .filter((t) => originalTabs.includes(t.id))
            .map((t) => t.windowId),
        ).size,
        1,
      );
      return {
        retainedTabIds: originalTabs,
        unsavedFormPreserved: true,
        uploadPreserved: true,
        otherSessionUnchanged: true,
      };
    }
    await test(
      0,
      "Codex restart resumes its own original window and unsaved form",
      async () => {
        const old = receipt(a).ownerPid;
        await a.client.close();
        await connectSession(a, "thread");
        assert.notEqual(receipt(a).ownerPid, old);
        return await assertResumed();
      },
    );
    await test(
      0,
      "resume without environment forwarding uses the same conversation key",
      async () => {
        await a.client.close();
        await connectSession(a, "explicit");
        return await assertResumed();
      },
    );
    await test(
      0,
      "resumed connection refuses another conversation and retains trusted input",
      async () => {
        const foreign = await a.client.callTool({
          name: "browser",
          arguments: { commands: "tab list", session_key: b.key },
        });
        assert.equal(foreign.isError, true);
        const before = await page(a).evaluate(() => window.proof.clicks);
        await call(a, "click '#click'");
        assert.deepEqual(
          await page(a).evaluate(() => [
            window.proof.clicks,
            window.proof.trusted,
          ]),
          [before + 1, true],
        );
        return await assertResumed();
      },
    );
  }
  if (resumeProbe) {
    await test(
      0,
      "agents can restart while Chromium remains open",
      async () => {
        const meta = receipt(a);
        const beforeA = await call(a, "tab list");
        const beforeB = await call(b, "tab list");
        await a.client.close();
        await b.client.close();
        process.kill(meta.browserPid, 0);
        await connectSession(a, "explicit");
        await connectSession(b, "explicit");
        assert.equal(await call(a, "tab list"), beforeA);
        assert.equal(await call(b, "tab list"), beforeB);
        return { browserStayedOpen: true, bothSessionTabListsPreserved: true };
      },
    );
    await test(
      0,
      "closing one conversation window recreates only that conversation",
      async () => {
        const other = await call(b, "tab list");
        const tab = Number(/^\* (\d+)/m.exec(await call(a, "tab list"))[1]);
        const worker = a.context
          .serviceWorkers()
          .filter((w) => w.url().includes(receipt(a).extensionId))
          .at(-1);
        await worker.evaluate(
          async (id) =>
            chrome.windows.remove((await chrome.tabs.get(id)).windowId),
          tab,
        );
        await ready(a);
        await call(
          a,
          `goto ${base}/?session=ALPHA&round=window-reopened\nclick '#click'\nfill '#name' "before"\nclick '#name'\npress Control+a\ntype "Reopened own window"`,
        );
        assert.equal(
          await page(a).locator("#name").inputValue(),
          "Reopened own window",
        );
        assert.deepEqual(
          await page(a).evaluate(() => [
            window.proof.clicks,
            window.proof.trusted,
          ]),
          [1, true],
        );
        assert.equal(await call(b, "tab list"), other);
        return {
          ownWindowReopened: true,
          otherSessionUnchanged: true,
          trustedInput: true,
        };
      },
    );
    async function closeWholeBrowser() {
      const meta = receipt(a);
      const cdp = await a.browser.newBrowserCDPSession();
      await cdp.send("Browser.close").catch(() => {});
      await bounded("normal browser and host exit", () => {
        for (const pid of [meta.browserPid, meta.hostPid]) {
          try {
            process.kill(pid, 0);
            return false;
          } catch {}
        }
        return true;
      });
    }
    async function verifyBrowserReopened() {
      await observe(a);
      await observe(b);
      await call(
        a,
        `goto ${base}/?session=ALPHA&round=browser-reopened\nclick '#click'\nfill '#name' "before"\nclick '#name'\npress Control+a\ntype "Browser reopened"`,
      );
      await call(b, `goto ${base}/?session=BETA&round=browser-reopened`);
      assert.equal(
        await page(a).locator("#name").inputValue(),
        "Browser reopened",
      );
      assert.deepEqual(
        await page(a).evaluate(() => [
          window.proof.clicks,
          window.proof.trusted,
        ]),
        [1, true],
      );
      assert.ok(!(await call(a, "tab list")).includes("session=BETA"));
      assert.ok(!(await call(b, "tab list")).includes("session=ALPHA"));
      assert.equal(
        (await a.context.cookies(base)).find((c) => c.name === "ss_login")
          ?.value,
        "login-1",
      );
      return {
        onDemandBrowserStart: true,
        bothSessionScopesRecovered: true,
        trustedInput: true,
        savedLoginCookiePreserved: true,
      };
    }
    await test(
      0,
      "closed Chromium restarts on the next request from a still-running agent",
      async () => {
        await closeWholeBrowser();
        await ready(a);
        await ready(b);
        return await verifyBrowserReopened();
      },
    );
    await test(
      0,
      "starting agents after Chromium was closed launches the same profile",
      async () => {
        await a.client.close();
        await b.client.close();
        await closeWholeBrowser();
        await connectSession(a, "explicit");
        await connectSession(b, "explicit");
        return await verifyBrowserReopened();
      },
    );
  }
  if (popupProbe) {
    await call(
      a,
      `goto ${base}/?session=ALPHA&round=popup\nfill '#name' "Keep parent form"`,
    );
    await call(
      b,
      `goto ${base}/?session=BETA&round=popup\nfill '#name' "Keep other form"`,
    );
    const mainA = Number(/^\* (\d+)/m.exec(await call(a, "tab list"))?.[1]);
    const mainB = Number(/^\* (\d+)/m.exec(await call(b, "tab list"))?.[1]);
    const opened = async (s, kind) => {
      let found;
      await bounded(`discover ${s.name} ${kind} popup`, async () => {
        const list = await call(s, "tab list");
        const row = list
          .split("\n")
          .find((line) =>
            line.includes(`/popup-flow?session=${s.name}&kind=${kind}`),
          );
        found = Number(/^[* ] (\d+)/.exec(row || "")?.[1]);
        return !!found;
      });
      return found;
    };
    const assertPopupInput = async (
      s,
      id,
      kind,
      opener = s === a ? mainA : mainB,
    ) => {
      await call(
        s,
        `tab popup ${opener} --url ${JSON.stringify(`kind=${kind}`)}\nfill '#popup-answer' "Popup ${kind}"\nclick '#popup-click'`,
      );
      assert.match(s.last.text, new RegExp(`tab ${id}; opener ${opener}`));
      const observed = s.context
        .pages()
        .find((p) =>
          p.url().includes(`/popup-flow?session=${s.name}&kind=${kind}`),
        );
      assert.ok(observed, `independent popup observer: ${kind}`);
      assert.equal(
        await observed.locator("#popup-answer").inputValue(),
        `Popup ${kind}`,
      );
      assert.deepEqual(
        await observed.evaluate(() => [popupProof.clicks, popupProof.trusted]),
        [1, true],
      );
      return observed;
    };
    await test(
      0,
      "feature popup: discover, type, trusted click and return to intact parent",
      async () => {
        await call(a, "click '#open-feature'");
        const id = await opened(a, "feature");
        await assertPopupInput(a, id, "feature");
        await call(a, `tab select ${mainA}`);
        assert.equal(
          await page(a).locator("#name").inputValue(),
          "Keep parent form",
        );
      },
    );
    await test(
      0,
      "nested popup inherits the correct conversation",
      async () => {
        const parent = await opened(a, "feature");
        await call(a, `tab select ${parent}\nclick '#nested'`);
        const id = await opened(a, "nested");
        await assertPopupInput(a, id, "nested", parent);
        assert.ok(!(await call(b, "tab list")).includes("kind=nested"));
        await call(a, `tab close ${id}\ntab select ${mainA}`);
      },
    );
    await test(
      0,
      "named popup reuse keeps its existing owned tab",
      async () => {
        await call(a, "click '#open-named'");
        const id = await opened(a, "named");
        await assertPopupInput(a, id, "named");
        await call(a, `tab select ${mainA}\nclick '#open-named'`);
        assert.equal(await opened(a, "named"), id);
        const list = await call(a, "tab list");
        assert.equal(
          list.split("\n").filter((line) => line.includes("kind=named")).length,
          1,
        );
        await call(a, `tab close ${id}\ntab select ${mainA}`);
      },
    );
    await test(
      0,
      "blank popup followed by delayed navigation remains controllable",
      async () => {
        await call(a, "click '#open-blank'");
        const id = await opened(a, "blank");
        await assertPopupInput(a, id, "blank");
        await call(a, `tab close ${id}\ntab select ${mainA}`);
      },
    );
    await test(0, "noopener popup retains conversation ownership", async () => {
      await call(a, "click '#open-noopener'");
      const id = await opened(a, "noopener");
      await assertPopupInput(a, id, "noopener");
      assert.ok(!(await call(b, "tab list")).includes("kind=noopener"));
      await call(a, `tab close ${id}\ntab select ${mainA}`);
    });
    await test(
      0,
      "OAuth-style popup redirects cross-origin, messages its opener and closes",
      async () => {
        await call(a, "click '#open-cross'");
        const id = await opened(a, "cross");
        await call(a, `tab select ${id}\nclick '#redirect'`);
        const observed = await assertPopupInput(a, id, "cross");
        assert.equal(new URL(observed.url()).hostname, "localhost");
        await call(a, "click '#finish'");
        await bounded("popup closes", () => observed.isClosed());
        await call(a, `tab select ${mainA}`);
        assert.deepEqual(
          await page(a).evaluate(() => [proof.messages, proof.lastPopup]),
          [1, "cross"],
        );
        assert.equal(
          await page(a).locator("#name").inputValue(),
          "Keep parent form",
        );
      },
    );
    await test(
      0,
      "worker restart retains popup ownership and live form input",
      async () => {
        await call(a, "click '#open-worker'");
        const id = await opened(a, "worker");
        const observed = await assertPopupInput(a, id, "worker");
        const cdp = await a.browser.newBrowserCDPSession();
        const workers = await cdp.send("Target.getTargets");
        const worker = workers.targetInfos.find(
          (t) =>
            t.type === "service_worker" &&
            t.url.includes("chrome-extension://"),
        );
        assert.ok(worker);
        await cdp.send("Target.closeTarget", { targetId: worker.targetId });
        await cdp.detach();
        await ready(a);
        await call(
          a,
          `tab select ${id}\nclick '#popup-answer'\npress Control+a\ntype "After worker restart"`,
        );
        assert.equal(
          await observed.locator("#popup-answer").inputValue(),
          "After worker restart",
        );
        await call(a, `tab close ${id}\ntab select ${mainA}`);
      },
    );
    await test(
      0,
      "simultaneous conversation popups cannot cross session boundaries",
      async () => {
        await Promise.all([
          call(a, "click '#open-dual'"),
          call(b, `tab select ${mainB}\nclick '#open-dual'`),
        ]);
        const idA = await opened(a, "dual"),
          idB = await opened(b, "dual");
        await Promise.all([
          assertPopupInput(a, idA, "dual"),
          assertPopupInput(b, idB, "dual"),
        ]);
        assert.ok(!(await call(a, "tab list")).includes("session=BETA"));
        assert.ok(!(await call(b, "tab list")).includes("session=ALPHA"));
        const rejected = await raw(a, `tab select ${idB}`);
        assert.equal(rejected.result.isError, true);
        await call(a, `tab close ${idA}\ntab select ${mainA}`);
        await call(b, `tab close ${idB}\ntab select ${mainB}`);
        assert.equal(
          await page(b).locator("#name").inputValue(),
          "Keep other form",
        );
      },
    );
    const firstDrop = path.join(out, "Drop résumé.txt");
    const secondDrop = path.join(out, "Drop cover letter.txt");
    writeFileSync(firstDrop, "Exact résumé content — 中文");
    writeFileSync(secondDrop, "Exact cover letter content");
    await test(
      0,
      "native file drop transfers full contents with trusted browser input",
      async () => {
        await call(
          a,
          `drop '#external-drop' ${JSON.stringify(firstDrop)} --native`,
        );
        await bounded(
          "first drop contents",
          async () => await page(a).evaluate(() => proof.drops.length === 1),
        );
        assert.deepEqual(await page(a).evaluate(() => proof.drops[0]), {
          files: [
            { name: "Drop résumé.txt", text: "Exact résumé content — 中文" },
          ],
          text: "",
          trusted: true,
        });
      },
    );
    await test(
      0,
      "multiple-file drop includes MIME text and preserves both documents",
      async () => {
        await call(
          a,
          `drop '#external-drop' ${JSON.stringify(firstDrop)} ${JSON.stringify(secondDrop)} --data '{"text/plain":"Application packet"}' --native`,
        );
        await bounded(
          "second drop contents",
          async () => await page(a).evaluate(() => proof.drops.length === 2),
        );
        assert.deepEqual(await page(a).evaluate(() => proof.drops[1]), {
          files: [
            { name: "Drop résumé.txt", text: "Exact résumé content — 中文" },
            {
              name: "Drop cover letter.txt",
              text: "Exact cover letter content",
            },
          ],
          text: "Application packet",
          trusted: true,
        });
      },
    );
    await test(
      0,
      "invalid drop data and missing files deliver no browser drop",
      async () => {
        for (const command of [
          "drop '#external-drop' --data '[]'",
          `drop '#external-drop' ${JSON.stringify(path.join(out, "does-not-exist.txt"))}`,
        ])
          assert.equal((await raw(a, command)).result.isError, true);
        assert.equal(await page(a).evaluate(() => proof.drops.length), 2);
      },
    );
    await test(
      0,
      "JavaScript alert can be accepted without losing the application form",
      async () => {
        await call(a, "click '#alert'");
        await call(a, "dialog accept");
        assert.equal(await page(a).evaluate(() => proof.alertDone), true);
        assert.equal(
          await page(a).locator("#name").inputValue(),
          "Keep parent form",
        );
      },
    );
    await test(0, "JavaScript confirmation can be dismissed", async () => {
      await call(a, "click '#confirm'");
      await call(a, "dialog dismiss");
      assert.equal(await page(a).evaluate(() => proof.confirmResult), false);
    });
    await test(
      0,
      "JavaScript prompt receives the exact supplied answer",
      async () => {
        await call(a, "click '#prompt'");
        await call(a, 'dialog accept "Confirmed prompt answer"');
        assert.equal(
          await page(a).evaluate(() => proof.promptResult),
          "Confirmed prompt answer",
        );
      },
    );
  }
  if (popupProbe) {
    const nativeDialog = async (s) => {
      const text = await call(s, "fedcm list --timeout 5000");
      const line = text
        .split("\n")
        .find((line) => line.startsWith('{"dialogId"'));
      assert.ok(
        line,
        `${text}; page error: ${await page(s).evaluate(() => window.fedError)}`,
      );
      return JSON.parse(line);
    };
    await test(
      0,
      "native account chooser selects an existing account and continues exactly once",
      async () => {
        const mainA = Number(/^\* (\d+)/m.exec(await call(a, "tab list"))?.[1]);
        await call(a, `tab new ${idp}/idp/login\ntab select ${mainA}`);
        await call(a, "fedcm list\nclick '#fedcm'");
        const dialog = await nativeDialog(a);
        assert.equal(dialog.dialogType, "AccountChooser");
        assert.equal(dialog.accounts[1].email, "fixture-1@example.test");
        const before = requests.filter(
          (request) => request.nativeSignIn,
        ).length;
        await call(a, `fedcm select ${dialog.dialogId} 1`);
        await bounded("native sign-in returns token", () =>
          page(a).evaluate(
            () => window.fedResult === "local-fixture:account-1",
          ),
        );
        assert.equal(
          requests.filter((request) => request.nativeSignIn).length,
          before + 1,
        );
      },
    );
    await test(
      0,
      "native account chooser reconnects after its agent restarts",
      async () => {
        await call(a, "click '#fedcm'");
        await nativeDialog(a);
        await a.client.close();
        await connectSession(a, "explicit");
        const dialog = await nativeDialog(a);
        const account = dialog.accounts.find(
          (account) => account.email === "fixture-0@example.test",
        );
        assert.ok(account, JSON.stringify(dialog));
        await call(a, `fedcm select ${dialog.dialogId} ${account.index}`);
        await bounded("resumed native sign-in", () =>
          page(a).evaluate(() => window.fedResult),
        );
        assert.equal(
          await page(a).evaluate(() => window.fedResult),
          "local-fixture:account-0",
        );
      },
    );
    await test(
      0,
      "native chooser rejects stale IDs and stays isolated from another conversation",
      async () => {
        await call(a, "click '#fedcm'");
        const dialog = await nativeDialog(a);
        const foreign = await call(b, "fedcm list");
        assert.match(foreign, /No native account chooser/);
        const stale = await raw(a, "fedcm select stale-id 0");
        assert.ok(stale.result.isError);
        await call(a, `fedcm dismiss ${dialog.dialogId}`);
        await bounded("native dismissal", () =>
          page(a).evaluate(() => !!window.fedError),
        );
      },
    );
  }
  if (popupProbe)
    await test(
      0,
      "native provider confirmation Continue opens sign-in and returns to the chooser",
      async () => {
        const mainA = Number(/^\* (\d+)/m.exec(await call(a, "tab list"))?.[1]);
        await call(
          a,
          `tab new ${idp}/idp/login\ntab select ${mainA}\neval "() => {window.fedMode='passive'}"`,
        );
        idpAccountsEmpty = true;
        await call(a, "click '#fedcm'");
        const readDialog = async () => {
          const text = await call(a, "fedcm list --timeout 3000");
          const line = text
            .split("\n")
            .find((line) => line.startsWith('{"dialogId"'));
          return line && JSON.parse(line);
        };
        const confirm = await bounded(
          "native provider confirmation",
          async () => {
            const dialog = await readDialog();
            return dialog?.dialogType === "ConfirmIdpLogin" && dialog;
          },
          6000,
        );
        idpAccountsEmpty = false;
        await call(a, `fedcm click ${confirm.dialogId} Continue`);
        const chooser = await bounded(
          "native chooser after Continue",
          async () => {
            const dialog = await readDialog();
            return dialog?.dialogType === "AccountChooser" && dialog;
          },
          6000,
        );
        await call(a, `fedcm select ${chooser.dialogId} 0`);
        await bounded("native Continue completes sign-in", () =>
          page(a).evaluate(() => window.fedResult),
        );
      },
    );
  // Supplemental read-only work on public sites, separate from the 500 local
  // destructive/stress cases so a site's network outage is reported accurately.
  const publicSites =
    process.env.SS_STRESS_PUBLIC_WEB === "0"
      ? []
      : [
          [a, "https://example.com/", /Example Domain/],
          [b, "https://www.chromium.org/Home/", /Chromium/],
        ];
  for (const [s, url, title] of publicSites) {
    try {
      const text = await call(s, `goto ${url}\nget title\nsnapshot -i`);
      assert.match(text, title);
      const observed = s.context.pages().find((p) => p.url().startsWith(url));
      assert.ok(observed);
      assert.match(await observed.title(), title);
      publicWeb.push({ url, ok: true, title: await observed.title() });
    } catch (error) {
      publicWeb.push({ url, ok: false, error: error.message });
    }
  }
  for (const s of sessions)
    await call(
      s,
      `screenshot --path ${JSON.stringify(path.join(out, `${s.name}-final.jpg`))}`,
    );
  const report = persist();
  assert.equal(report.passed, planned);
  assert.equal(report.failed, 0);
  writeFileSync(
    path.join(
      root,
      popupProbe
        ? "session-popup-latest.json"
        : resumeProbe
          ? "session-resume-latest.json"
          : planned === 500
            ? "session-stress-latest.json"
            : "session-input-recovery-latest.json",
    ),
    JSON.stringify({ out, ...report }, null, 2),
  );
  console.log(
    JSON.stringify({
      finished: true,
      passed: report.passed,
      failed: report.failed,
      out,
    }),
  );
} finally {
  persist();
  for (const s of sessions) {
    await s.client?.close().catch(() => {});
  }
  const closed = new Set();
  for (const s of sessions) {
    if (existsSync(path.join(s.state, "daemon", "browser-host.json"))) {
      const meta = receipt(s);
      if (closed.has(meta.home)) continue;
      closed.add(meta.home);
      try {
        process.kill(meta.hostPid);
      } catch {}
      for (const file of [path.join(meta.home, `daemon-${meta.port}.json`)]) {
        if (existsSync(file)) {
          try {
            process.kill(JSON.parse(readFileSync(file, "utf8")).pid);
          } catch {}
        }
      }
      try {
        process.kill(meta.browserPid);
      } catch {}
    }
    await s.browser?.close().catch(() => {});
  }
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  enforceTestStorageBudget();
}
