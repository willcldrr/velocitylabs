import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { encrypt, decrypt } from "@/lib/crypto"
import { safeFetch } from "@/lib/safe-fetch"

/**
 * Cron job to refresh Instagram tokens before they expire
 * Should run daily via Vercel Cron or external scheduler
 *
 * Tokens expire after 60 days - we refresh when < 7 days remaining
 */

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  // Verify cron secret (mandatory)
  const authHeader = request.headers.get("authorization")
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error("CRON_SECRET not configured")
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 })
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = getSupabase()
  const results: { refreshed: string[]; failed: string[]; skipped: string[] } = {
    refreshed: [],
    failed: [],
    skipped: [],
  }

  // Find tokens expiring within 7 days
  const sevenDaysFromNow = new Date()
  sevenDaysFromNow.setDate(sevenDaysFromNow.getDate() + 7)

  // LB-6 dual-read: select both plaintext and encrypted trio so we can
  // refresh tokens written either way.
  const { data: expiringConnections } = await supabase
    .from("instagram_connections")
    .select(
      "id, user_id, instagram_username, access_token, token_expires_at, encrypted_access_token, access_token_iv, access_token_tag"
    )
    .eq("is_active", true)
    .lt("token_expires_at", sevenDaysFromNow.toISOString())

  if (!expiringConnections || expiringConnections.length === 0) {
    return NextResponse.json({ message: "No tokens need refresh", ...results })
  }

  // Refresh each expiring token
  for (const connection of expiringConnections) {
    try {
      // LB-6 dual-read: prefer encrypted trio, fall back to legacy plaintext.
      let currentToken: string | null = null
      if (
        connection.encrypted_access_token &&
        connection.access_token_iv &&
        connection.access_token_tag
      ) {
        try {
          currentToken = decrypt({
            ciphertext: connection.encrypted_access_token,
            iv: connection.access_token_iv,
            tag: connection.access_token_tag,
          })
        } catch (err) {
          console.error(`[Token Refresh] Decrypt failed for ${connection.instagram_username}`)
        }
      }
      if (!currentToken) {
        currentToken = connection.access_token
      }
      if (!currentToken) {
        results.failed.push(connection.instagram_username || connection.id)
        continue
      }

      const refreshResponse = await safeFetch(
        `https://graph.facebook.com/v19.0/oauth/access_token?` +
        new URLSearchParams({
          grant_type: "fb_exchange_token",
          client_id: process.env.META_APP_ID!,
          client_secret: process.env.META_APP_SECRET!,
          fb_exchange_token: currentToken,
        }).toString(),
        { timeoutMs: 30_000 }
      )

      if (!refreshResponse.ok) {
        const error = await refreshResponse.json()
        console.error(`[Token Refresh] Failed for ${connection.instagram_username}:`, error)
        results.failed.push(connection.instagram_username || connection.id)

        // Mark connection as needing attention if token is invalid
        if (error.error?.code === 190) { // Invalid/expired token
          await supabase
            .from("instagram_connections")
            .update({ is_active: false })
            .eq("id", connection.id)
        }
        continue
      }

      const tokenData = await refreshResponse.json()
      const newExpiresAt = new Date(Date.now() + (tokenData.expires_in || 5184000) * 1000)

      // LB-6 dual-write: store encrypted trio and keep plaintext column
      // populated until the drop migration runs.
      // TODO(LB-6 cutover): remove plaintext write after drop migration
      const enc = encrypt(tokenData.access_token)
      await supabase
        .from("instagram_connections")
        .update({
          access_token: tokenData.access_token,
          encrypted_access_token: enc.ciphertext,
          access_token_iv: enc.iv,
          access_token_tag: enc.tag,
          token_expires_at: newExpiresAt.toISOString(),
        })
        .eq("id", connection.id)

      results.refreshed.push(connection.instagram_username || connection.id)
    } catch (error) {
      console.error(`[Token Refresh] Error for ${connection.instagram_username}:`, error)
      results.failed.push(connection.instagram_username || connection.id)
    }
  }

  return NextResponse.json({
    message: `Processed ${expiringConnections.length} tokens`,
    ...results,
  })
}
