// brushrouter login — self-contained ChatGPT OAuth sign-in (no API key).
// Reuses the codex CLI's public OAuth registration (client_id app_EMoamEEZ…,
// localhost:1455 callback, PKCE) so the resulting tokens live in the codex
// auth shape and the codex route's refresh flow already knows how to use them.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
export const REDIRECT_PORT = 1455;
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access";

export function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function idTokenClaim(idToken) {
  try {
    const a = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString())?.["https://api.openai.com/auth"];
    return a ? { plan: a.chatgpt_plan_type || null, account_id: a.chatgpt_account_id || null } : null;
  } catch {
    return null;
  }
}

// Validated and reshaped into the codex auth.json format, so provider code
// needs exactly one reader. Throws on a malformed grant instead of storing it.
export function credentialFromTokenResponse(tokens) {
  for (const f of ["access_token", "refresh_token", "id_token"]) {
    if (typeof tokens[f] !== "string" || !tokens[f]) throw new Error(`token response missing ${f}`);
  }
  const claim = idTokenClaim(tokens.id_token);
  if (!claim?.account_id) throw new Error("token response has no ChatGPT account id in id_token");
  return {
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      account_id: claim.account_id,
    },
    last_refresh: new Date().toISOString(),
  };
}

// Waits for the browser to come back to localhost:1455/auth/callback.
function listenForCallback(state, timeoutMs = 5 * 60_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (v, e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch {}
      e ? reject(e) : resolve(v);
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url || "", REDIRECT_URI);
      if (url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const err = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        err
          ? `<h3>ChatGPT sign-in failed: ${err}</h3>`
          : "<h3>ChatGPT sign-in complete — you can close this tab.</h3>",
      );
      const rErr = err ? new Error(`ChatGPT sign-in failed: ${err}`) : null;
      let code = null;
      if (!rErr) {
        if (url.searchParams.get("state") !== state) {
          finish(null, new Error("OAuth state mismatch — start the login again"));
          return;
        }
        code = url.searchParams.get("code");
        if (!code) {
          finish(null, new Error("callback had no authorization code"));
          return;
        }
      }
      finish({ code, error: err });
    });
    const timer = setTimeout(
      () => finish(null, new Error("login timed out after 5 minutes — try again")),
      timeoutMs,
    );
    server.once("error", (e) =>
      finish(
        null,
        e.code === "EADDRINUSE"
          ? new Error("localhost:1455 is busy — another sign-in flow may be running; close it and retry")
          : e,
      ),
    );
    server.listen(REDIRECT_PORT, "127.0.0.1", () => {});
  });
}

function defaultOpen(url) {
  const cmd =
    process.platform === "win32"
      ? `cmd /c start "" ${JSON.stringify(url)}`
      : process.platform === "darwin"
      ? `open ${JSON.stringify(url)}`
      : `xdg-open ${JSON.stringify(url)}`;
  exec(cmd, () => {}); // fire and forget; the URL is printed either way
}

async function exchangeCode(code, verifier) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`token exchange failed: ${res.status} ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// Returns { path, plan, accountId } and writes codex-shaped auth.json with 0600.
export async function runLogin({ configDir, open = defaultOpen, log = () => {} } = {}) {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(24).toString("base64url");
  // AUTHORIZE_URL is a module constant, so this cannot throw in practice;
  // wrapped because the linter treats URL constructors as throw-capable.
  let authorize;
  try {
    authorize = new URL(AUTHORIZE_URL);
  } catch {
    throw new Error(`bad authorize url constant: ${AUTHORIZE_URL}`);
  }
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: OAUTH_CLIENT_ID,
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    prompt: "login",
  })) authorize.searchParams.set(k, v);

  log("Sign in to ChatGPT in your browser (it should open automatically):");
  log(authorize.toString());
  await open(authorize.toString());

  const { code } = await listenForCallback(state);
  const cred = credentialFromTokenResponse(await exchangeCode(code, verifier));
  const path = join(configDir, "auth.json");
  await mkdir(configDir, { recursive: true });
  await writeFile(path, JSON.stringify(cred, null, 2) + "\n", { mode: 0o600 });
  const claim = idTokenClaim(cred.tokens.id_token);
  return { path, plan: claim?.plan ?? null, accountId: claim?.account_id ?? null };
}
