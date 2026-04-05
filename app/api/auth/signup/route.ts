import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { Resend } from "resend"
import { applyRateLimit } from "@/lib/api-rate-limit"
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
  const limited = await applyRateLimit(request, { limit: 5, window: 60 })
  if (limited) return limited

  try {
    const { email, password, fullName, phone } = await request.json()

    if (!email || !password || !fullName) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    const supabase = getSupabase()

    // Create the user via admin API (without sending Supabase's own email)
    const { data, error } = await supabase.auth.admin.generateLink({
      type: "signup",
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          phone: phone || null,
        },
      },
    })

    let userId = data?.user?.id

    if (error) {
      if (error.message?.toLowerCase().includes("already registered") ||
          error.message?.toLowerCase().includes("already been registered")) {
        // Look up existing user with pagination
        const { data: users } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 })
        const existingUser = users?.users?.find(u => u.email === email)

        if (existingUser?.email_confirmed_at) {
          // Instead of revealing the account exists, return same response
          return NextResponse.json({ success: true, message: "Verification code sent to your email" })
        }

        userId = existingUser?.id
        if (!userId) {
          // Instead of revealing the account exists, return same response
          return NextResponse.json({ success: true, message: "Verification code sent to your email" })
        }
      } else {
        return NextResponse.json({ error: error.message }, { status: 400 })
      }
    }

    // Generate our own 6-digit OTP
    const otp = generateOtp()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 minutes

    // Invalidate any existing unused codes for this email
    await supabase
      .from("otp_codes")
      .update({ used: true })
      .eq("email", email)
      .eq("used", false)

    // Store the OTP
    const { error: insertError } = await supabase
      .from("otp_codes")
      .insert({
        email,
        code: otp,
        user_id: userId,
        expires_at: expiresAt,
      })

    if (insertError) {
      console.error("Failed to store OTP:", insertError)
      return NextResponse.json(
        { error: "Failed to generate verification code" },
        { status: 500 }
      )
    }

    // Send OTP via Resend
    await sendOtpEmail(email, otp, fullName)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Signup API error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

async function sendOtpEmail(email: string, otp: string, name: string) {
  await resend.emails.send({
    from: "Velocity <noreply@managevelocity.com>",
    to: email,
    subject: `${otp} is your verification code`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #000; margin-bottom: 8px;">Verify your email</h2>
        <p style="color: #666; font-size: 16px;">Hi ${name},</p>
        <p style="color: #666; font-size: 16px;">Enter this code to complete your signup:</p>
        <div style="background: #f4f4f5; border-radius: 12px; padding: 24px; text-align: center; margin: 24px 0;">
          <span style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #000;">${otp}</span>
        </div>
        <p style="color: #999; font-size: 14px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  })
}
