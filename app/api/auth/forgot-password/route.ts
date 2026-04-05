import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { Resend } from "resend"
import { applyAuthRateLimit } from "@/lib/auth-rate-limit"
import { log } from "@/lib/log"
import crypto from "crypto"

const resend = new Resend(process.env.RESEND_API_KEY)

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString()
}

export async function POST(request: NextRequest) {
  let email: string | undefined
  try {
    const body = await request.json()
    email = body?.email
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  // LB-11: composite (email+IP) rate-limit.
  const limited = await applyAuthRateLimit(request, email, { limit: 5, window: 60 })
  if (limited) return limited

  try {
    if (!email) {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400 }
      )
    }

    const supabase = getSupabase()

    // Look up the user — don't reveal whether they exist
    const { data: users } = await supabase.auth.admin.listUsers()
    const user = users?.users?.find(u => u.email === email)

    if (!user) {
      // Return success to not leak email existence
      return NextResponse.json({ success: true })
    }

    // Generate 6-digit OTP
    const otp = generateOtp()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()

    // Invalidate previous codes for this email
    await supabase
      .from("otp_codes")
      .update({ used: true })
      .eq("email", email)
      .eq("used", false)

    // Store OTP
    const { error: insertError } = await supabase
      .from("otp_codes")
      .insert({
        email,
        code: otp,
        user_id: user.id,
        expires_at: expiresAt,
      })

    if (insertError) {
      log.error("[auth.forgot-password] failed to store OTP", insertError, { route: "auth.forgot-password", code: (insertError as any)?.code })
      return NextResponse.json(
        { error: "Failed to send reset code" },
        { status: 500 }
      )
    }

    // Get user's name for the email
    const name = user.user_metadata?.full_name || ""

    await resend.emails.send({
      from: "Velocity <noreply@managevelocity.com>",
      to: email,
      subject: `${otp} is your password reset code`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #000; margin-bottom: 8px;">Reset your password</h2>
          <p style="color: #666; font-size: 16px;">${name ? `Hi ${name},` : "Hi,"}</p>
          <p style="color: #666; font-size: 16px;">Enter this code to reset your password:</p>
          <div style="background: #f4f4f5; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
            <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #000;">${otp}</span>
          </div>
          <p style="color: #999; font-size: 14px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    log.error("[auth.forgot-password] unhandled error", error, { route: "auth.forgot-password" })
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
