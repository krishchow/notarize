import { importPKCS8, SignJWT } from "jose";
import { ToolError } from "../core/result";

export const ASC_AUDIENCE = "appstoreconnect-v1";

export interface AscTokenOptions {
  keyId: string;
  /** Team keys have an issuer; individual keys don't (they use sub="user"). */
  issuerId?: string;
  privateKeyPem: string;
  /** Apple allows at most 20 minutes. */
  lifetimeSeconds?: number;
  now?: () => number;
}

/** Creates and caches ES256 JWTs for the App Store Connect API. */
export class AscTokenProvider {
  private cached?: { token: string; exp: number };
  private readonly lifetime: number;
  private readonly now: () => number;

  constructor(private readonly opts: AscTokenOptions) {
    this.lifetime = Math.min(opts.lifetimeSeconds ?? 1140, 1200);
    this.now = opts.now ?? Date.now;
  }

  get keyId(): string {
    return this.opts.keyId;
  }

  get isIndividualKey(): boolean {
    return !this.opts.issuerId;
  }

  async token(): Promise<string> {
    const nowSec = Math.floor(this.now() / 1000);
    if (this.cached && this.cached.exp - 60 > nowSec) return this.cached.token;
    let key: CryptoKey;
    try {
      key = await importPKCS8(this.opts.privateKeyPem.trim(), "ES256");
    } catch (e) {
      throw new ToolError(
        `App Store Connect private key is not a valid PKCS#8 EC key: ${(e as Error).message}`,
        {
          hint: "Use the AuthKey_<KEYID>.p8 file exactly as downloaded from App Store Connect.",
        },
      );
    }
    const exp = nowSec + this.lifetime;
    const payload: Record<string, unknown> = this.opts.issuerId ? {} : { sub: "user" };
    let jwt = new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", kid: this.opts.keyId, typ: "JWT" })
      .setIssuedAt(nowSec)
      .setExpirationTime(exp)
      .setAudience(ASC_AUDIENCE);
    if (this.opts.issuerId) jwt = jwt.setIssuer(this.opts.issuerId);
    const token = await jwt.sign(key);
    this.cached = { token, exp };
    return token;
  }
}
