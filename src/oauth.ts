import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Request, type RequestHandler, type Response } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";

const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
const SUPPORTED_SCOPE = "mcp:tools";

interface StoredToken {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

interface PersistedOAuthState {
  version: 1;
  approvalKeyId: string;
  clients: OAuthClientInformationFull[];
  accessTokens: Record<string, StoredToken>;
  refreshTokens: Record<string, StoredToken>;
}

interface AuthorizationCode {
  clientId: string;
  params: AuthorizationParams;
  expiresAt: number;
}

interface PendingAuthorization extends AuthorizationCode {
  code: string;
  client: OAuthClientInformationFull;
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function opaqueToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function secretMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function oauthHome(): string {
  const configured = process.env.LOCALWORKSPACEBRIDGE_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".local-workspace-bridge");
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

class PersistentClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly provider: LocalWorkspaceBridgeOAuthProvider) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.provider.client(clientId);
  }

  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    if (!client.redirect_uris.length || client.redirect_uris.length > 10 || client.redirect_uris.some((uri) => !validRedirectUri(uri))) {
      throw new InvalidClientMetadataError("redirect_uris must contain 1-10 HTTPS or loopback callback URLs without fragments");
    }
    if (client.grant_types?.some((grant) => !["authorization_code", "refresh_token"].includes(grant))) {
      throw new InvalidClientMetadataError("Only authorization_code and refresh_token grants are supported");
    }
    if (client.response_types?.some((responseType) => responseType !== "code")) {
      throw new InvalidClientMetadataError("Only the code response type is supported");
    }
    if (client.token_endpoint_auth_method && !["none", "client_secret_post"].includes(client.token_endpoint_auth_method)) {
      throw new InvalidClientMetadataError("Unsupported token endpoint authentication method");
    }
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: crypto.randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000)
    };
    this.provider.saveClient(registered);
    return registered;
  }
}

export class LocalWorkspaceBridgeOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private state: PersistedOAuthState;
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly approvalAttempts = new Map<string, number>();

  constructor(
    readonly issuerUrl: URL,
    readonly resourceUrl: URL,
    private readonly approvalSecret: string,
    private readonly statePath: string
  ) {
    this.state = this.loadState();
    this.clientsStore = new PersistentClientsStore(this);
    this.prune();
  }

  client(clientId: string): OAuthClientInformationFull | undefined {
    return this.state.clients.find((client) => client.client_id === clientId);
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.state.clients = [...this.state.clients.filter((item) => item.client_id !== client.client_id), client].slice(-100);
    this.persist();
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.validateScopes(params.scopes);
    this.validateResource(params.resource);
    if (!client.redirect_uris.includes(params.redirectUri)) throw new InvalidGrantError("Unregistered redirect URI");
    const approvalId = opaqueToken();
    const code = opaqueToken();
    this.pending.set(approvalId, {
      code,
      client,
      clientId: client.client_id,
      params,
      expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS
    });
    res.status(200).type("html").send(this.consentPage(approvalId, client, params));
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = this.codes.get(authorizationCode);
    if (!code || code.expiresAt < Date.now() || code.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return code.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const code = this.codes.get(authorizationCode);
    if (!code || code.expiresAt < Date.now() || code.clientId !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== code.params.redirectUri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    this.validateResource(resource ?? code.params.resource);
    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, code.params.scopes?.length ? code.params.scopes : [SUPPORTED_SCOPE]);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.prune();
    const hash = tokenHash(refreshToken);
    const stored = this.state.refreshTokens[hash];
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt < Date.now()) throw new InvalidGrantError("Invalid or expired refresh token");
    this.validateResource(resource ? resource : new URL(stored.resource));
    const requestedScopes = scopes?.length ? scopes : stored.scopes;
    this.validateScopes(requestedScopes);
    if (requestedScopes.some((scope) => !stored.scopes.includes(scope))) throw new InvalidScopeError("Refresh scope exceeds the original grant");
    delete this.state.refreshTokens[hash];
    return this.issueTokens(client.client_id, requestedScopes);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.prune();
    const stored = this.state.accessTokens[tokenHash(token)];
    if (!stored || stored.expiresAt < Date.now() || stored.resource !== this.resourceUrl.href) throw new Error("Invalid or expired access token");
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expiresAt / 1000),
      resource: new URL(stored.resource)
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = tokenHash(request.token);
    if (this.state.accessTokens[hash]?.clientId === client.client_id) delete this.state.accessTokens[hash];
    if (this.state.refreshTokens[hash]?.clientId === client.client_id) delete this.state.refreshTokens[hash];
    this.persist();
  }

  approvalHandler(): RequestHandler {
    return (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      const approvalId = typeof req.body?.approval_id === "string" ? req.body.approval_id : "";
      const pending = this.pending.get(approvalId);
      if (!pending || pending.expiresAt < Date.now()) {
        res.status(400).type("html").send(this.messagePage("Authorization expired", "Return to ChatGPT and start the connection again."));
        return;
      }
      const target = new URL(pending.params.redirectUri);
      if (req.body?.decision === "deny") {
        this.pending.delete(approvalId);
        target.searchParams.set("error", new AccessDeniedError("Authorization denied").errorCode);
        target.searchParams.set("state", pending.params.state ?? "");
        res.redirect(302, target.href);
        return;
      }
      const suppliedSecret = typeof req.body?.approval_secret === "string" ? req.body.approval_secret.trim() : "";
      if (!secretMatches(this.approvalSecret, suppliedSecret)) {
        const attempts = (this.approvalAttempts.get(approvalId) ?? 0) + 1;
        this.approvalAttempts.set(approvalId, attempts);
        if (attempts >= 5) this.pending.delete(approvalId);
        res.status(403).type("html").send(this.messagePage("Approval key rejected", "The key did not match. Return to ChatGPT and try the OAuth connection again."));
        return;
      }
      this.pending.delete(approvalId);
      this.approvalAttempts.delete(approvalId);
      this.codes.set(pending.code, {
        clientId: pending.clientId,
        params: pending.params,
        expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS
      });
      target.searchParams.set("code", pending.code);
      if (pending.params.state !== undefined) target.searchParams.set("state", pending.params.state);
      res.redirect(302, target.href);
    };
  }

  private validateScopes(scopes?: string[]): void {
    if (scopes?.some((scope) => scope !== SUPPORTED_SCOPE)) throw new InvalidScopeError("Unsupported scope");
  }

  private validateResource(resource?: URL): void {
    if (resource && resource.href !== this.resourceUrl.href) throw new InvalidTargetError("Resource does not match this LocalWorkspaceBridge server");
  }

  private issueTokens(clientId: string, scopes: string[]): OAuthTokens {
    const accessToken = opaqueToken();
    const refreshToken = opaqueToken();
    const now = Date.now();
    this.state.accessTokens[tokenHash(accessToken)] = { clientId, scopes, resource: this.resourceUrl.href, expiresAt: now + ACCESS_TOKEN_TTL_MS };
    this.state.refreshTokens[tokenHash(refreshToken)] = { clientId, scopes, resource: this.resourceUrl.href, expiresAt: now + REFRESH_TOKEN_TTL_MS };
    this.persist();
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: scopes.join(" ")
    };
  }

  private loadState(): PersistedOAuthState {
    const approvalKeyId = tokenHash(this.approvalSecret).slice(0, 24);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (
        parsed?.version === 1 &&
        parsed.approvalKeyId === approvalKeyId &&
        Array.isArray(parsed.clients) &&
        parsed.accessTokens && typeof parsed.accessTokens === "object" &&
        parsed.refreshTokens && typeof parsed.refreshTokens === "object"
      ) return parsed;
    } catch {}
    return { version: 1, approvalKeyId, clients: [], accessTokens: {}, refreshTokens: {} };
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.statePath);
    try { fs.chmodSync(this.statePath, 0o600); } catch {}
  }

  private prune(): void {
    const now = Date.now();
    for (const [hash, token] of Object.entries(this.state.accessTokens)) if (token.expiresAt < now) delete this.state.accessTokens[hash];
    for (const [hash, token] of Object.entries(this.state.refreshTokens)) if (token.expiresAt < now) delete this.state.refreshTokens[hash];
    for (const [code, value] of this.codes) if (value.expiresAt < now) this.codes.delete(code);
    for (const [id, value] of this.pending) if (value.expiresAt < now) this.pending.delete(id);
  }

  private consentPage(approvalId: string, client: OAuthClientInformationFull, params: AuthorizationParams): string {
    const clientName = client.client_name || "ChatGPT MCP client";
    const redirectOrigin = new URL(params.redirectUri).origin;
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize LocalWorkspaceBridge</title>
<style>body{font-family:system-ui;background:#111;color:#eee;margin:0;padding:32px}.card{max-width:620px;margin:5vh auto;background:#1d1d1d;border:1px solid #444;border-radius:18px;padding:28px}input,button{box-sizing:border-box;width:100%;padding:13px;margin-top:12px;border-radius:10px;border:1px solid #666;font-size:16px}button{background:#fff;color:#111;font-weight:700}.deny{background:#2a2a2a;color:#eee}code{word-break:break-all;color:#9fd}.warn{padding:12px;background:#3a2610;border-radius:10px}</style>
<main class="card"><h1>Authorize LocalWorkspaceBridge</h1><p><strong>${htmlEscape(clientName)}</strong> is requesting access to this workspace through <code>${htmlEscape(redirectOrigin)}</code>.</p><p class="warn">This LocalWorkspaceBridge instance may expose workspace writes and a full system shell. Approve only if you initiated this connection in ChatGPT.</p><form method="post" action="/oauth/approve"><input type="hidden" name="approval_id" value="${htmlEscape(approvalId)}"><label>LocalWorkspaceBridge approval key<input type="password" name="approval_secret" required autocomplete="one-time-code" autofocus></label><button name="decision" value="approve">Authorize ChatGPT</button><button class="deny" name="decision" value="deny" formnovalidate>Deny</button></form></main></html>`;
  }

  private messagePage(title: string, message: string): string {
    return `<!doctype html><html><meta charset="utf-8"><title>${htmlEscape(title)}</title><body style="font-family:system-ui;background:#111;color:#eee;padding:40px"><h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p></body></html>`;
  }
}

export function createLocalWorkspaceBridgeOAuth(publicBaseUrl: string, approvalSecret: string): {
  provider: LocalWorkspaceBridgeOAuthProvider;
  router: RequestHandler;
  bearer: RequestHandler;
  resourceMetadataUrl: string;
} {
  const issuerUrl = new URL(publicBaseUrl);
  issuerUrl.pathname = "/";
  issuerUrl.search = "";
  issuerUrl.hash = "";
  const resourceUrl = new URL("/mcp", issuerUrl);
  const id = crypto.createHash("sha256").update(resourceUrl.href).digest("hex").slice(0, 24);
  const statePath = path.join(oauthHome(), "oauth", `${id}.json`);
  const provider = new LocalWorkspaceBridgeOAuthProvider(issuerUrl, resourceUrl, approvalSecret, statePath);
  const router = express.Router();
  router.post("/oauth/approve", express.urlencoded({ extended: false, limit: "8kb" }), provider.approvalHandler());
  router.use(mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl: resourceUrl,
    scopesSupported: [SUPPORTED_SCOPE],
    resourceName: "LocalWorkspaceBridge workspace"
  }));
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  return {
    provider,
    router,
    bearer: requireBearerAuth({ verifier: provider, requiredScopes: [SUPPORTED_SCOPE], resourceMetadataUrl }),
    resourceMetadataUrl
  };
}
