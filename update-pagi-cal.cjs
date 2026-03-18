#!/usr/bin/env node

/**
 * Updates GitHub Secrets for Pagi and Cal bank credentials
 * Requires: GITHUB_TOKEN environment variable (Personal Access Token)
 */

const https = require('https');
const sodium = require('libsodium-wrappers');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'Yklein888';
const REPO_NAME = 'finfamily-bank-scraper';

if (!GITHUB_TOKEN) {
  console.error('❌ GITHUB_TOKEN not set. Set it with: export GITHUB_TOKEN="your_token"');
  console.error('   Create a token at: https://github.com/settings/tokens');
  process.exit(1);
}

// Credentials to update
const credentials = {
  PAGI_USERNAME: 'I766ALK',
  PAGI_PASSWORD: '5380266Jj@',
  CAL_USERNAME: '025538026',
  CAL_PASSWORD: '5380266JjJjJj',
};

/**
 * Make GitHub API request
 */
function githubRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path,
      method,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'bank-scraper-secret-updater',
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, data: parsed });
          } else {
            reject(new Error(`GitHub API error ${res.statusCode}: ${data}`));
          }
        } catch (e) {
          reject(new Error(`GitHub API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Get public key for secret encryption
 */
async function getPublicKey() {
  const { data } = await githubRequest(
    'GET',
    `/repos/${REPO_OWNER}/${REPO_NAME}/actions/secrets/public-key`
  );
  return data;
}

/**
 * Encrypt value using libsodium sealed box
 * GitHub uses libsodium's crypto_box_seal for secret encryption
 */
async function encryptSecret(publicKeyBase64, secretValue) {
  // Wait for libsodium to be ready
  await sodium.ready;

  // Decode the public key from base64
  const publicKey = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);

  // Convert secret value to bytes
  const message = sodium.from_string(secretValue);

  // Encrypt using sealed box (crypto_box_seal)
  const encrypted = sodium.crypto_box_seal(message, publicKey);

  // Return base64 encoded encrypted value
  return sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
}

/**
 * Set a GitHub secret
 */
async function setSecret(secretName, encryptedValue, publicKeyId) {
  await githubRequest(
    'PUT',
    `/repos/${REPO_OWNER}/${REPO_NAME}/actions/secrets/${secretName}`,
    {
      encrypted_value: encryptedValue,
      key_id: publicKeyId,
    }
  );
  console.log(`✅ Updated ${secretName}`);
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('🔐 Initializing libsodium...');
    await sodium.ready;

    console.log('📦 Fetching GitHub public key...');
    const pubkey = await getPublicKey();
    console.log(`✓ Public key ID: ${pubkey.key_id}`);

    console.log('🔐 Encrypting credentials...');
    for (const [secretName, secretValue] of Object.entries(credentials)) {
      const encrypted = await encryptSecret(pubkey.key, secretValue);
      await setSecret(secretName, encrypted, pubkey.key_id);
    }

    console.log('✨ All secrets updated successfully!');
    console.log('🚀 Triggering workflow...');

    // Trigger workflow
    await githubRequest(
      'POST',
      `/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/auto-scrape.yml/dispatches`,
      { ref: 'main' }
    );

    console.log('✅ Workflow triggered!');
    console.log('📊 Check: https://github.com/yklein89/finfamily-bank-scraper/actions');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
