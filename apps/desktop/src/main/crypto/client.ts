/**
 * @mun/desktop — delegate voting-key management
 *
 * On a delegate's first login, an Ed25519 keypair is generated in the main
 * process. The PRIVATE key is stored only in the encrypted store (OS keychain)
 * and never leaves the device. The PUBLIC key is registered with the server
 * once; afterwards the delegate can sign votes that the server verifies against
 * the registered key.
 */

import {
  generateEd25519KeyPair,
  signVote,
  publicKeyFromPrivateKey,
  type Ed25519KeyPair,
} from '@mun/crypto';
import type { VoteChoice } from '@mun/protocol';
import { store } from '../store/encrypted.js';

class CryptoClient {
  /** Ensure a delegate keypair exists in the store; return the public key. */
  ensureKeyPair(): string {
    const state = store.get();
    if (state.delegatePrivateKey) {
      // Derive public key from the stored private key for consistency.
      const pub = derivePublic(state.delegatePrivateKey);
      return pub;
    }
    const kp = generateEd25519KeyPair();
    store.update({ delegatePrivateKey: kp.privateKeyB64, delegatePublicKey: kp.publicKeyB64 });
    return kp.publicKeyB64;
  }

  getPublicKey(): string | null {
    const state = store.get();
    if (state.delegatePublicKey) return state.delegatePublicKey;
    if (state.delegatePrivateKey) return derivePublic(state.delegatePrivateKey);
    return null;
  }

  /** Sign a vote with the stored private key. Throws if no key is registered. */
  signVote(params: { voteId: string; delegateId: string; choice: VoteChoice; clientCastId: string }): string {
    const priv = store.get().delegatePrivateKey;
    if (!priv) throw new Error('No delegate voting key — cannot sign vote');
    return signVote(params, priv);
  }

  clearKey(): void {
    store.update({ delegatePrivateKey: undefined, delegatePublicKey: undefined });
  }
}

function derivePublic(privB64: string): string {
  return publicKeyFromPrivateKey(privB64);
}

export const cryptoClient = new CryptoClient();

// Extend the persisted state with the delegate's voting keys.
declare module '@shared/ipc' {
  interface PersistedState {
    delegatePrivateKey?: string;
    delegatePublicKey?: string;
  }
}
