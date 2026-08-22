import { generateAuthenticationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { AccountAuthenticationRecord } from "./password-auth.js";
import type { PasskeyRecord, PasskeyVerifier } from "./account-recovery.js";

export interface WebAuthnConfiguration { rpId: string; rpName: string; expectedOrigin: string }

export class WebAuthnPasskeyVerifier implements PasskeyVerifier {
  constructor(readonly configuration: WebAuthnConfiguration) {}
  registrationOptions(challenge: string, account: AccountAuthenticationRecord) {
    return {
      challenge,
      rp: { id: this.configuration.rpId, name: this.configuration.rpName },
      user: { id: Buffer.from(account.id).toString("base64url"), name: account.email, displayName: account.name },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }, { type: "public-key", alg: -257 }],
      timeout: 300_000,
      attestation: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    };
  }
  authenticationOptions(challenge: string) {
    return generateAuthenticationOptions({ challenge, rpID: this.configuration.rpId, userVerification: "required" });
  }
  async register(challenge: string, input: Record<string, unknown>) {
    const result = await verifyRegistrationResponse({
      response: input as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: this.configuration.expectedOrigin,
      expectedRPID: this.configuration.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -8, -257],
    });
    if (!result.verified) throw new Error("WebAuthn registration was not verified");
    const credential = result.registrationInfo.credential;
    return {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      ...(credential.transports ? { transports: credential.transports } : {}),
    };
  }
  async authenticate(challenge: string, input: Record<string, unknown>, passkey: PasskeyRecord) {
    const result = await verifyAuthenticationResponse({
      response: input as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: this.configuration.expectedOrigin,
      expectedRPID: this.configuration.rpId,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, "base64url")),
        counter: passkey.counter,
        ...(passkey.transports ? { transports: passkey.transports as AuthenticatorTransportFuture[] } : {}),
      },
    });
    const nextCounter = result.authenticationInfo.newCounter;
    const counterRolledBack = (passkey.counter > 0 || nextCounter > 0) && nextCounter <= passkey.counter;
    if (!result.verified || counterRolledBack) throw new Error("WebAuthn assertion was not verified");
    return { newCounter: nextCounter };
  }
}
