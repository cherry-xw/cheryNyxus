import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface OAuth2Config {
  enabled?: boolean;
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userInfoUrl?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  /** Accounts allowed to administer this installation. Match provider sub, email or preferred_username. */
  adminUsers?: string[];
  /** Optional claim-based admin mapping, e.g. roles + ["admin"]. */
  adminClaim?: string;
  adminValues?: string[];
  /** Additional separately-hosted internal UIs allowed to open a control socket. */
  trustedOrigins?: string[];
  sessionSecret?: string;
}

export interface AuthenticatedUser {
  sub: string;
  username: string;
  isAdmin: true;
}

interface SessionPayload extends AuthenticatedUser { exp: number }
interface OAuthState { verifier: string; returnTo: string; exp: number }

const SESSION_COOKIE = "chery_session";
const STATE_COOKIE = "chery_oauth_state";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;

/**
 * Server-side OIDC/OAuth2 login gate. OAuth2 alone does not identify people,
 * so this implementation requires the provider userinfo endpoint (OIDC is the
 * usual choice) and never offers public self-registration.
 */
export class OAuth2Auth {
  readonly enabled: boolean;
  private readonly cfg: Required<Pick<OAuth2Config, "adminUsers" | "adminValues" | "trustedOrigins">> & OAuth2Config;
  private readonly secret: string;

  constructor(config: OAuth2Config | undefined) {
    this.enabled = config?.enabled === true;
    this.cfg = { ...config, adminUsers: config?.adminUsers ?? [], adminValues: config?.adminValues ?? ["admin"], trustedOrigins: config?.trustedOrigins ?? [] };
    this.secret = config?.sessionSecret || process.env.CHERY_AUTH_SESSION_SECRET || "";
    if (this.enabled) {
      for (const key of ["authorizationUrl", "tokenUrl", "userInfoUrl", "clientId", "redirectUri"]) {
        if (!this.cfg[key as keyof OAuth2Config]) throw new Error(`server.auth.enabled=true requires server.auth.${key}`);
      }
      if (!this.secret || this.secret.length < 32) throw new Error("server.auth.enabled=true requires a 32+ character CHERY_AUTH_SESSION_SECRET (or server.auth.sessionSecret)");
      if (this.cfg.adminUsers.length === 0 && !this.cfg.adminClaim) throw new Error("OAuth2 login needs server.auth.adminUsers or server.auth.adminClaim; public registration is intentionally disabled");
    }
  }

  getUser(req: IncomingMessage): AuthenticatedUser | null {
    if (!this.enabled) return { sub: "local", username: "local", isAdmin: true };
    const token = readCookie(req, SESSION_COOKIE);
    const payload = token ? this.verify<SessionPayload>(token) : null;
    return payload && payload.exp > nowSeconds() ? { sub: payload.sub, username: payload.username, isAdmin: true } : null;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/api/auth/me") {
      const user = this.getUser(req);
      writeJson(res, user ? 200 : 401, user ? { authenticated: true, user } : { authenticated: false });
      return true;
    }
    if (path === "/api/auth/logout" && req.method === "POST") {
      this.clearCookies(res, req);
      writeJson(res, 204);
      return true;
    }
    if (path === "/api/auth/login") {
      if (!this.enabled) { res.writeHead(302, { Location: "/" }); res.end(); return true; }
      const returnTo = safeReturnTo(new URL(req.url ?? "/", "http://localhost").searchParams.get("returnTo"));
      const verifier = randomBytes(32).toString("base64url");
      const state = this.sign<OAuthState>({ verifier, returnTo, exp: nowSeconds() + STATE_TTL_SECONDS });
      this.setCookie(res, STATE_COOKIE, state, req, STATE_TTL_SECONDS);
      const url = new URL(this.cfg.authorizationUrl!);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", this.cfg.clientId!);
      url.searchParams.set("redirect_uri", this.cfg.redirectUri!);
      url.searchParams.set("scope", "openid profile email");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", base64url(createHash("sha256").update(verifier).digest()));
      url.searchParams.set("code_challenge_method", "S256");
      res.writeHead(302, { Location: url.toString() }); res.end();
      return true;
    }
    if (path === "/api/auth/callback") {
      await this.callback(req, res);
      return true;
    }
    return false;
  }

  isTrustedOrigin(origin: string | undefined, req: IncomingMessage): boolean {
    if (!this.enabled) return true;
    if (!origin) return false;
    if (this.cfg.trustedOrigins.includes(origin)) return true;
    try {
      const originUrl = new URL(origin);
      const forwardedHost = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]?.trim() ?? "";
      const host = forwardedHost ? new URL(`http://${forwardedHost}`).hostname.toLowerCase() : "";
      return Boolean(host) && originUrl.hostname.toLowerCase() === host;
    } catch { return false; }
  }

  private async callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const state = url.searchParams.get("state") ?? "";
    const expected = readCookie(req, STATE_COOKIE);
    const saved = expected && constantTimeEqual(state, expected) ? this.verify<OAuthState>(state) : null;
    const code = url.searchParams.get("code");
    if (!saved || saved.exp <= nowSeconds() || !code) { writeJson(res, 400, { error: "Invalid or expired OAuth2 login state" }); return; }
    try {
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.cfg.redirectUri!, client_id: this.cfg.clientId!, code_verifier: saved.verifier });
      if (this.cfg.clientSecret) body.set("client_secret", this.cfg.clientSecret);
      const tokenRes = await fetch(this.cfg.tokenUrl!, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
      if (!tokenRes.ok) throw new Error(`token endpoint returned ${tokenRes.status}`);
      const token = await tokenRes.json() as { access_token?: string };
      if (!token.access_token) throw new Error("token response has no access_token");
      const infoRes = await fetch(this.cfg.userInfoUrl!, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" } });
      if (!infoRes.ok) throw new Error(`userinfo endpoint returned ${infoRes.status}`);
      const profile = await infoRes.json() as Record<string, unknown>;
      const sub = typeof profile.sub === "string" ? profile.sub : "";
      const username = firstString(profile, ["preferred_username", "email", "name", "sub"]);
      if (!sub || !username || !this.isAdmin(profile, sub, username)) { writeJson(res, 403, { error: "Only configured admin accounts may access or register this service" }); return; }
      this.setCookie(res, SESSION_COOKIE, this.sign<SessionPayload>({ sub, username, isAdmin: true, exp: nowSeconds() + SESSION_TTL_SECONDS }), req, SESSION_TTL_SECONDS);
      this.setCookie(res, STATE_COOKIE, "", req, 0);
      res.writeHead(302, { Location: saved.returnTo }); res.end();
    } catch (error) { writeJson(res, 502, { error: "OAuth2 login failed", detail: (error as Error).message }); }
  }

  private isAdmin(profile: Record<string, unknown>, sub: string, username: string): boolean {
    const identifiers = [sub, username, typeof profile.email === "string" ? profile.email : ""];
    if (identifiers.some((id) => this.cfg.adminUsers.includes(id))) return true;
    const claim = this.cfg.adminClaim ? profile[this.cfg.adminClaim] : undefined;
    const values = Array.isArray(claim) ? claim.filter((v): v is string => typeof v === "string") : typeof claim === "string" ? [claim] : [];
    return values.some((value) => this.cfg.adminValues.includes(value));
  }

  private sign<T>(payload: T): string { const encoded = base64url(Buffer.from(JSON.stringify(payload))); return `${encoded}.${base64url(createHmac("sha256", this.secret).update(encoded).digest())}`; }
  private verify<T>(token: string): T | null { const [encoded, sig, ...extra] = token.split("."); if (!encoded || !sig || extra.length || !constantTimeEqual(sig, base64url(createHmac("sha256", this.secret).update(encoded).digest()))) return null; try { return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T; } catch { return null; } }
  private setCookie(res: ServerResponse, name: string, value: string, req: IncomingMessage, maxAge: number): void { const secure = isHttps(req); const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`]; if (secure) attrs.push("Secure"); appendCookie(res, attrs.join("; ")); }
  private clearCookies(res: ServerResponse, req: IncomingMessage): void { this.setCookie(res, SESSION_COOKIE, "", req, 0); this.setCookie(res, STATE_COOKIE, "", req, 0); }
}

function nowSeconds(): number { return Math.floor(Date.now() / 1000); }
function base64url(value: Buffer): string { return value.toString("base64url"); }
function readCookie(req: IncomingMessage, name: string): string | undefined { const pair = req.headers.cookie?.split(/;\s*/).find((item) => item.startsWith(`${name}=`)); return pair ? decodeURIComponent(pair.slice(name.length + 1)) : undefined; }
function appendCookie(res: ServerResponse, value: string): void { const current = res.getHeader("Set-Cookie"); res.setHeader("Set-Cookie", current ? [...(Array.isArray(current) ? current : [String(current)]), value] : value); }
function writeJson(res: ServerResponse, status: number, body?: unknown): void { res.writeHead(status, body === undefined ? undefined : { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(body === undefined ? undefined : JSON.stringify(body)); }
function safeReturnTo(value: string | null): string { return value?.startsWith("/") && !value.startsWith("//") ? value : "/"; }
function firstString(value: Record<string, unknown>, keys: string[]): string { for (const key of keys) if (typeof value[key] === "string" && value[key]) return value[key] as string; return ""; }
function constantTimeEqual(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function isHttps(req: IncomingMessage): boolean { return (req.socket as { encrypted?: boolean }).encrypted === true || (String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() ?? "") === "https"; }
