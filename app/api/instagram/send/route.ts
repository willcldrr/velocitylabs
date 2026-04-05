import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { sendInstagramMessage, InstagramCredentials } from "@/lib/instagram"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { decrypt } from "@/lib/crypto"

export const dynamic = "force-dynamic"

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    const supabase = getSupabase()

    // Verify authenticated user
    const authHeader = request.headers.get("authorization")
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""))
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { leadId, message } = await request.json()

    if (!leadId || !message) {
      return NextResponse.json({ error: "leadId and message are required" }, { status: 400 })
    }

    // Get the lead to find Instagram user ID
    const { data: lead } = await supabase
      .from("leads")
      .select("instagram_user_id, user_id")
      .eq("id", leadId)
      .single()

    if (!lead || !lead.instagram_user_id) {
      return NextResponse.json({ error: "Lead has no Instagram account linked" }, { status: 400 })
    }

    // Verify the lead belongs to this user
    if (lead.user_id !== user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
    }

    // Get Instagram credentials for this user.
    // LB-6 dual-read: prefer encrypted trio, fall back to legacy plaintext.
    const { data: connection } = await supabase
      .from("instagram_connections")
      .select(
        "access_token, instagram_account_id, encrypted_access_token, access_token_iv, access_token_tag"
      )
      .eq("user_id", user.id)
      .eq("is_active", true)
      .single()

    let credentials: InstagramCredentials | undefined

    if (connection) {
      let accessToken: string | null = null
      if (
        connection.encrypted_access_token &&
        connection.access_token_iv &&
        connection.access_token_tag
      ) {
        try {
          accessToken = decrypt({
            ciphertext: connection.encrypted_access_token,
            iv: connection.access_token_iv,
            tag: connection.access_token_tag,
          })
        } catch (err) {
          console.error("[instagram/send] Failed to decrypt access token")
        }
      }
      if (!accessToken) {
        accessToken = connection.access_token
      }
      if (accessToken) {
        credentials = {
          accessToken,
          accountId: connection.instagram_account_id,
        }
      }
    }

    // Send via Instagram
    const result = await sendInstagramMessage(lead.instagram_user_id, message, credentials)

    if (!result.success) {
      return NextResponse.json({ error: result.error || "Failed to send Instagram message" }, { status: 500 })
    }

    return NextResponse.json({ success: true, messageId: result.messageId })
  } catch (error) {
    console.error("[Instagram Send] Error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
