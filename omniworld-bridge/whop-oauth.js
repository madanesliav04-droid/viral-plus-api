"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// Tokens never leave the server. A dedicated Railway volume holds only ciphertext.
function createWhopOAuth({env = process.env, request = fetch, clock = Date.now}) {
  const clientId = env.WHOP_CLIENT_ID || "app_gGGQXuk3OaYUkP";
  const secret = env.WHOP_CLIENT_SECRET;
  const expectedUser = env.WHOP_PUBLISHER_USER_ID || "user_Lcgrt81hIa1TM";
  const redirect = "https://telegram-whop-bridge-production.up.railway.app/oauth/whop/callback";
  const directory = env.WHOP_OAUTH_DATA_DIR;
  const encryptionSecret = env.WHOP_OAUTH_ENCRYPTION_KEY;
  const configured = Boolean(secret && directory && encryptionSecret && encryptionSecret.length >= 32 &&
    (!env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_VOLUME_MOUNT_PATH === directory));
  const key = configured ? crypto.createHash("sha256").update(encryptionSecret).digest() : null;
  const pending = new Map();
  let credentials = null, lastError = "", refreshPromise = null, authorizationBusy = false;
  const filename = directory && path.join(directory, "whop-oauth.enc");
  const fail = message => new Error(message);
  function valid(data) {
    return data && typeof data.access_token === "string" && data.access_token.length > 0 &&
      typeof data.refresh_token === "string" && data.refresh_token.length > 0 &&
      Number.isFinite(data.expires_at) && data.user_id === expectedUser;
  }
  async function persist(data) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(clientId));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    const temporary = filename + "." + crypto.randomBytes(8).toString("hex");
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({v:1, iv:iv.toString("base64"), tag:cipher.getAuthTag().toString("base64"), data:encrypted.toString("base64")}));
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, filename);
    const dir = await fs.open(directory, "r");
    try { await dir.sync(); } finally { await dir.close(); }
  }
  const ready = (async () => {
    if (!configured) return;
    try {
      // The mount must already exist: never silently fall back to ephemeral storage.
      await fs.access(directory, fs.constants.W_OK);
      const stored = JSON.parse(await fs.readFile(filename, "utf8"));
      if (stored.v !== 1) throw fail("format");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(stored.iv, "base64"));
      decipher.setAAD(Buffer.from(clientId));
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.data, "base64")), decipher.final()]).toString("utf8"));
      if (!valid(data)) throw fail("format");
      credentials = data;
    } catch (e) {
      if (e.code !== "ENOENT" || e.path !== filename) lastError = "Stockage OAuth indisponible ou illisible. Reconnexion nécessaire.";
    }
  })();
  async function tokenRequest(payload) {
    let response;
    try {
      response = await request("https://api.whop.com/oauth/token", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({...payload, client_id:clientId, client_secret:secret}),
        signal:AbortSignal.timeout(15000)
      });
    } catch { throw fail("Whop OAuth : connexion interrompue. Reconnecte Whop si nécessaire."); }
    if (!response.ok) {
      const detail = await response.json().catch(()=>({}));
      // Only allowlisted codes and locally written hints leave this function.
      // Provider messages can echo credentials, so never log their raw text.
      const candidate = typeof detail.error === "string" ? detail.error : detail.error?.type;
      const allowed = new Set(["invalid_client","invalid_grant","invalid_request","unauthorized_client","access_denied","insufficient_scope","unauthorized","forbidden","bad_request","invalid_api_key"]);
      const code = allowed.has(candidate) ? candidate : "unspecified_error";
      const description = String(detail.error_description || detail.error?.message || detail.message || "").toLowerCase();
      let hint = "Aucun détail reconnu.";
      if (description.includes("oauth:token_exchange")) hint = "Whop signale la permission oauth:token_exchange.";
      else if (/client.?secret|client secret/.test(description)) hint = "Whop signale le secret client.";
      else if (/api.?key|api key/.test(description)) hint = "Whop signale la clé API de l’application.";
      else if (/client.?id|client id/.test(description)) hint = "Whop signale l’identifiant de l’application.";
      else if (/code.*expir|expir.*code/.test(description)) hint = "Whop signale un code expiré.";
      else if (/code.*used|used.*code/.test(description)) hint = "Whop signale un code déjà utilisé.";
      else if (/redirect/.test(description)) hint = "Whop signale l’adresse de retour.";
      else if (/pkce|verifier/.test(description)) hint = "Whop signale la vérification PKCE.";
      else if (/permission|scope/.test(description)) hint = "Whop signale une permission manquante.";
      lastError = "Whop OAuth : HTTP " + response.status + " — " + code + ". " + hint;
      console.warn("[whop-oauth]", lastError);
      throw fail(lastError);
    }
    let result;
    try { result = await response.json(); } catch { throw fail("Whop OAuth : réponse invalide."); }
    if (!result.access_token || !result.refresh_token || !Number.isFinite(result.expires_in) || result.expires_in <= 60 ||
        String(result.token_type).toLowerCase() !== "bearer") throw fail("Whop OAuth : jetons incomplets.");
    return {access_token:result.access_token, refresh_token:result.refresh_token, expires_at:clock()+result.expires_in*1000, user_id:expectedUser};
  }
  async function start() {
    await ready;
    if (!configured) throw fail("Configuration OAuth Railway incomplète.");
    if (authorizationBusy || refreshPromise) throw fail("Connexion Whop en cours. Réessaie dans quelques secondes.");
    try { await fs.access(directory, fs.constants.W_OK); } catch { throw fail("Stockage OAuth indisponible."); }
    // One operator and one publisher: a fresh flow replaces any abandoned flow.
    pending.clear();
    const state = crypto.randomBytes(32).toString("base64url");
    // Required by Whop for openid. Identity is verified via authenticated
    // userinfo; this application never consumes the returned ID token.
    const nonce = crypto.randomBytes(32).toString("base64url");
    const browser = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(32).toString("base64url");
    pending.set(state, {browser, verifier, until:clock()+10*60*1000});
    const query = new URLSearchParams({response_type:"code", client_id:clientId, redirect_uri:redirect,
      scope:"openid profile chat:read chat:message:create", state, nonce,
      code_challenge:crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method:"S256"});
    return {url:"https://api.whop.com/oauth/authorize?"+query, browser};
  }
  async function callback({state, code, browser, denied}) {
    await ready;
    const flow = typeof state === "string" && pending.get(state);
    if (!flow || typeof browser !== "string" || flow.browser !== browser || flow.until < clock()) {
      throw fail("Connexion expirée ou non reconnue. Recommence depuis le bouton Connecter Whop.");
    }
    pending.delete(state);
    if (denied || typeof code !== "string" || !code || code.length > 4096) throw fail("Autorisation Whop annulée. Tu peux recommencer.");
    if (authorizationBusy || refreshPromise) throw fail("Connexion en cours. Réessaie.");
    authorizationBusy = true;
    try {
      const data = await tokenRequest({grant_type:"authorization_code", code, code_verifier:flow.verifier, redirect_uri:redirect});
      let user;
      try {
        const response = await request("https://api.whop.com/oauth/userinfo", {headers:{Authorization:"Bearer "+data.access_token}, signal:AbortSignal.timeout(15000)});
        if (!response.ok) throw fail("userinfo");
        user = await response.json();
      } catch { throw fail("Whop OAuth : impossible de vérifier le compte connecté."); }
      if (user.sub !== expectedUser) throw fail("Mauvais compte Whop. Reconnecte-toi avec urfavceo75.");
      try { await persist(data); } catch { throw fail("Impossible de conserver la connexion Whop. Vérifie le stockage Railway."); }
      credentials = data;
      lastError = "";
    } finally { authorizationBusy = false; }
  }
  async function accessToken() {
    await ready;
    if (authorizationBusy) throw fail("Connexion Whop en cours.");
    if (!credentials) throw fail("Clique sur Connecter Whop avant de tester.");
    if (credentials.expires_at > clock()+60000) return credentials.access_token;
    if (!refreshPromise) refreshPromise = (async () => {
      try {
        const next = await tokenRequest({grant_type:"refresh_token", refresh_token:credentials.refresh_token});
        // Persist the rotated token before returning it to any request.
        await persist(next);
        credentials = next;
        lastError = "";
        return next.access_token;
      } catch {
        credentials = null;
        lastError = "Renouvellement Whop interrompu. Reconnecte Whop.";
        // Never reuse a possibly consumed rotating refresh token after restart.
        try { await fs.unlink(filename); } catch {}
        throw fail(lastError);
      } finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }
  return {ready, start, callback, accessToken, status:()=>({configured, connected:Boolean(credentials), error:lastError})};
}
module.exports = {createWhopOAuth};
