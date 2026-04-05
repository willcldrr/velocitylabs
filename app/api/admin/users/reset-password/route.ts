import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createServerClient } from "@/lib/supabase/server"
import { Resend } from "resend"
import { applyRateLimit } from "@/lib/api-rate-limit"
import crypto from "crypto"
import { log } from "@/lib/log"

const resend = new Resend(process.env.RESEND_API_KEY)

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// POST - Admin sends a password reset email to a user
export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 10, window: 60 })
  if (limited) return limited

  try {
    const serverSupabase = await createServerClient()
    const { data: { user }, error: authError } = await serverSupabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const supabase = getSupabase()

    const { data: profile } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single()

    if (!profile?.is_admin) {
      return NextResponse.json({ error: "Admin access required" }, { status: 403 })
    }

    const { userId, newPassword } = await request.json()

    if (!userId) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 })
    }

    // If admin provides a password directly, set it
    if (newPassword) {
      if (newPassword.length < 6) {
        return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 })
      }

      const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
        password: newPassword,
      })

      if (updateError) {
        return NextResponse.json({ error: updateError.message }, { status: 500 })
      }

      return NextResponse.json({ success: true, method: "password_set" })
    }

    // Otherwise, send a reset code via email
    const { data: targetUser } = await supabase.auth.admin.getUserById(userId)
    if (!targetUser?.user?.email) {
      return NextResponse.json({ error: "User has no email" }, { status: 400 })
    }

    const otp = crypto.randomInt(100000, 999999).toString()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    // Invalidate previous codes
    await supabase
      .from("otp_codes")
      .update({ used: true })
      .eq("email", targetUser.user.email)
      .eq("used", false)

    // Store OTP
    await supabase.from("otp_codes").insert({
      email: targetUser.user.email,
      code: otp,
      user_id: userId,
      expires_at: expiresAt,
    })

    const name = targetUser.user.user_metadata?.full_name || ""

    await resend.emails.send({
      from: "Velocity <noreply@managevelocity.com>",
      to: targetUser.user.email,
      subject: `${otp} — Password reset requested by admin`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #000; margin-bottom: 8px;">Password Reset</h2>
          <p style="color: #666; font-size: 16px;">${name ? `Hi ${name},` : "Hi,"}</p>
          <p style="color: #666; font-size: 16px;">An administrator has requested a password reset for your account. Use this code to set a new password:</p>
          <div style="background: #f4f4f5; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
            <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #000;">${otp}</span>
          </div>
          <p style="color: #999; font-size: 14px;">This code expires in 10 minutes. If you didn't expect this, please contact support.</p>
        </div>
      `,
    })

    return NextResponse.json({ success: true, method: "email_sent" })
  } catch (error) {
    log.error("Admin reset password error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
