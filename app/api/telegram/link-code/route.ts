import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"

// Generate a random 6-character code
function generateCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // Excluding confusing chars like 0, O, 1, I
  let code = ""
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Delete any existing unused codes for this user
    await supabase
      .from("telegram_link_codes")
      .delete()
      .eq("user_id", user.id)
      .is("used_at", null)

    // Generate a new code
    const code = generateCode()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

    const { data, error } = await supabase
      .from("telegram_link_codes")
      .insert({
        user_id: user.id,
        code,
        expires_at: expiresAt.toISOString(),
      })
      .select()
      .single()

    if (error) {
      console.error("Error creating link code:", error)
      return NextResponse.json({ error: "Failed to generate code" }, { status: 500 })
    }

    return NextResponse.json({
      code: data.code,
      expiresAt: data.expires_at,
    })
  } catch (error) {
    console.error("Link code error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// Get current Telegram connection status
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("telegram_chat_id, telegram_username, telegram_linked_at")
      .eq("id", user.id)
      .single()

    return NextResponse.json({
      connected: !!profile?.telegram_chat_id,
      username: profile?.telegram_username,
      linkedAt: profile?.telegram_linked_at,
    })
  } catch (error) {
    console.error("Get Telegram status error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// Disconnect Telegram
export async function DELETE(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const { error } = await supabase
      .from("profiles")
      .update({
        telegram_chat_id: null,
        telegram_username: null,
        telegram_linked_at: null,
      })
      .eq("id", user.id)

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Disconnect Telegram error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
