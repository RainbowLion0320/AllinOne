#!/usr/bin/env node
/**
 * Zero-dependency App Store Connect API helper that creates or fetches an active
 * `IOS_APP_STORE` provisioning profile for `com.allinone.dshmobile` (requiring ZERO
 * registered device UDIDs), installs it into Xcode's provisioning profile directories,
 * and writes an `ExportOptions.plist` configured for deterministic manual App Store signing.
 *
 * Required env vars:
 *   APPLE_API_KEY_PATH   Path to AuthKey_<KEY_ID>.p8
 *   APPLE_API_KEY_ID     10-character App Store Connect Key ID
 *   APPLE_API_ISSUER     App Store Connect Issuer ID (UUID)
 *
 * Optional env vars:
 *   IOS_BUNDLE_ID        Default: com.allinone.dshmobile
 *   IOS_TEAM_ID          Default: 37FM46Q69N
 *   IOS_PROFILE_NAME     Default: All in One App Store
 *   IOS_CERT_SERIAL      Optional hex serial number to match a specific Apple Distribution cert
 *   EXPORT_PLIST_OUT     Optional path to write a manual-signing ExportOptions.plist
 */

import { createPrivateKey, createSign } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const ASC_API_BASE = 'https://api.appstoreconnect.apple.com/v1'

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8')
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function createAscJwt({ keyPath, keyId, issuerId }) {
  const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'))
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({
      iss: issuerId,
      iat: now,
      exp: now + 600,
      aud: 'appstoreconnect-v1',
    }),
  )
  const signingInput = `${header}.${payload}`
  const signer = createSign('SHA256')
  signer.update(signingInput)
  signer.end()
  const sig = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${b64url(sig)}`
}

async function ascFetch(token, path, { method = 'GET', body = null } = {}) {
  const res = await fetch(`${ASC_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) {
    const detail = json?.errors?.map((e) => `${e.code || e.status}: ${e.title} ${e.detail || ''}`).join('; ') || text
    throw new Error(`App Store Connect API ${method} ${path} failed (HTTP ${res.status}): ${detail}`)
  }
  return json
}

function normalizeSerial(raw) {
  return String(raw || '')
    .trim()
    .replace(/^0x/i, '')
    .replace(/:/g, '')
    .replace(/^0+/, '')
    .toUpperCase()
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function renderManualExportPlist({ bundleId, teamId, profileName }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>destination</key>
\t<string>export</string>
\t<key>manageAppVersionAndBuildNumber</key>
\t<false/>
\t<key>method</key>
\t<string>app-store-connect</string>
\t<key>provisioningProfiles</key>
\t<dict>
\t\t<key>${xmlEscape(bundleId)}</key>
\t\t<string>${xmlEscape(profileName)}</string>
\t</dict>
\t<key>signingCertificate</key>
\t<string>Apple Distribution</string>
\t<key>signingStyle</key>
\t<string>manual</string>
\t<key>stripSwiftSymbols</key>
\t<true/>
\t<key>teamID</key>
\t<string>${xmlEscape(teamId)}</string>
\t<key>uploadSymbols</key>
\t<true/>
</dict>
</plist>
`
}

async function main() {
  const keyPath = String(process.env.APPLE_API_KEY_PATH || '').trim()
  const keyId = String(process.env.APPLE_API_KEY_ID || '').trim()
  const issuerId = String(process.env.APPLE_API_ISSUER || '').trim()
  if (!keyPath || !keyId || !issuerId) {
    throw new Error('Missing required env vars: APPLE_API_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER')
  }

  const bundleIdentifier = String(process.env.IOS_BUNDLE_ID || 'com.allinone.dshmobile').trim()
  const teamId = String(process.env.IOS_TEAM_ID || '37FM46Q69N').trim()
  const profileName = String(process.env.IOS_PROFILE_NAME || 'All in One App Store').trim()
  const wantSerial = normalizeSerial(process.env.IOS_CERT_SERIAL || '')
  const exportPlistOut = String(process.env.EXPORT_PLIST_OUT || '').trim()

  const token = createAscJwt({ keyPath, keyId, issuerId })

  // 1. Find Bundle ID resource
  const bundleRes = await ascFetch(
    token,
    `/bundleIds?filter[identifier]=${encodeURIComponent(bundleIdentifier)}&limit=20`,
  )
  const bundleItem = (bundleRes?.data || []).find((b) => b?.attributes?.identifier === bundleIdentifier)
  if (!bundleItem?.id) {
    throw new Error(`Bundle ID "${bundleIdentifier}" not found in App Store Connect`)
  }

  // 2. Find active Apple Distribution certificate
  const certRes = await ascFetch(
    token,
    '/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=50',
  )
  const nowMs = Date.now()
  const activeCerts = (certRes?.data || []).filter((c) => {
    const exp = Date.parse(c?.attributes?.expirationDate || '')
    return !Number.isNaN(exp) && exp > nowMs
  })
  if (activeCerts.length === 0) {
    throw new Error('No active Apple Distribution certificate found in Apple Developer Portal')
  }
  let chosenCert = null
  if (wantSerial) {
    chosenCert = activeCerts.find((c) => normalizeSerial(c?.attributes?.serialNumber) === wantSerial) || null
  }
  if (!chosenCert) {
    // Prefer modern universal DISTRIBUTION cert with latest expiration
    activeCerts.sort((a, b) => {
      const aUni = a?.attributes?.certificateType === 'DISTRIBUTION' ? 1 : 0
      const bUni = b?.attributes?.certificateType === 'DISTRIBUTION' ? 1 : 0
      if (aUni !== bUni) return bUni - aUni
      return Date.parse(b?.attributes?.expirationDate || 0) - Date.parse(a?.attributes?.expirationDate || 0)
    })
    chosenCert = activeCerts[0]
  }

  // 3. Look up existing active IOS_APP_STORE profile matching our bundle ID & certificate
  const profRes = await ascFetch(
    token,
    `/profiles?filter[profileType]=IOS_APP_STORE&filter[name]=${encodeURIComponent(profileName)}&include=certificates,bundleId&limit=20`,
  )
  let activeProfile = null
  for (const p of profRes?.data || []) {
    const attrs = p?.attributes || {}
    const exp = Date.parse(attrs.expirationDate || '')
    const pBundleId = p?.relationships?.bundleId?.data?.id || ''
    const pCertIds = (p?.relationships?.certificates?.data || []).map((c) => c.id)
    if (
      attrs.profileState === 'ACTIVE' &&
      !Number.isNaN(exp) &&
      exp > nowMs + 7 * 24 * 60 * 60 * 1000 &&
      pBundleId === bundleItem.id &&
      pCertIds.includes(chosenCert.id)
    ) {
      activeProfile = p
      break
    }
    // Delete stale/invalid/mismatched profile with the same name so creation succeeds cleanly
    if (attrs.name === profileName) {
      await ascFetch(token, `/profiles/${encodeURIComponent(p.id)}`, { method: 'DELETE' }).catch(() => {})
    }
  }

  if (!activeProfile) {
    const created = await ascFetch(token, '/profiles', {
      method: 'POST',
      body: {
        data: {
          type: 'profiles',
          attributes: {
            name: profileName,
            profileType: 'IOS_APP_STORE',
          },
          relationships: {
            bundleId: {
              data: { type: 'bundleIds', id: bundleItem.id },
            },
            certificates: {
              data: [{ type: 'certificates', id: chosenCert.id }],
            },
          },
        },
      },
    })
    activeProfile = created?.data
  }

  const profileUuid = String(activeProfile?.attributes?.uuid || '').trim()
  const profileContentB64 = String(activeProfile?.attributes?.profileContent || '').trim()
  if (!profileUuid || !profileContentB64) {
    throw new Error('App Store Connect returned a provisioning profile without uuid or profileContent')
  }

  const profileBytes = Buffer.from(profileContentB64, 'base64')
  const installDirs = [
    join(homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles'),
    join(homedir(), 'Library', 'Developer', 'Xcode', 'UserData', 'Provisioning Profiles'),
  ]
  for (const dir of installDirs) {
    mkdirSync(dir, { recursive: true })
    const outPath = join(dir, `${profileUuid}.mobileprovision`)
    writeFileSync(outPath, profileBytes)
    chmodSync(outPath, 0o600)
  }

  if (exportPlistOut) {
    mkdirSync(dirname(exportPlistOut), { recursive: true })
    writeFileSync(
      exportPlistOut,
      renderManualExportPlist({ bundleId: bundleIdentifier, teamId, profileName }),
      'utf8',
    )
  }

  console.log(
    JSON.stringify({
      ok: true,
      bundleId: bundleIdentifier,
      certificateId: chosenCert.id,
      certificateName: chosenCert.attributes?.name || '',
      profileId: activeProfile.id,
      profileName,
      profileUuid,
      expirationDate: activeProfile.attributes?.expirationDate || '',
    }),
  )
}

main().catch((err) => {
  console.error(`[sync-ios-appstore-profile] ${err?.message || err}`)
  process.exit(1)
})
