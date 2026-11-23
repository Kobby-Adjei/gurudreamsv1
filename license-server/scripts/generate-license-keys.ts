/**
 * Generate a new Ed25519 license-signing keypair.
 *   npm run keys:generate
 * PRIVATE key  -> license server env LICENSE_SIGNING_KEY_PEM (keep secret; never commit).
 * PUBLIC key   -> desktop/src/main/license/publicKeys.ts LICENSE_PUBLIC_KEYS[<kid>] (injected at build).
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const kid = `ab-${new Date().toISOString().slice(0, 7)}-${randomBytes(3).toString('hex')}`;

process.stdout.write(
  [
    `# Key id (LICENSE_KEY_ID and the LICENSE_PUBLIC_KEYS map key): ${kid}`,
    '',
    '# PRIVATE key — LICENSE_SIGNING_KEY_PEM (secret!):',
    privPem.trim(),
    '',
    '# Same private key on one line (for env UIs that do not accept newlines):',
    JSON.stringify(privPem),
    '',
    '# PUBLIC key — embed in the desktop app (SPKI PEM):',
    pubPem.trim(),
    '',
  ].join('\n'),
);
