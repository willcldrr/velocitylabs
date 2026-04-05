import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { createClient } from "@supabase/supabase-js"
import { z } from "zod"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

const deletionRequestSchema = z.object({
  email: z.string().email("Invalid email address"),
  confirmEmail: z.string().email("Invalid email address"),
  deletionType: z.enum(["account", "instagram", "leads", "messages", "all"]),
  additionalInfo: z.string().optional(),
  acknowledged: z.literal(true, {
    errorMap: () => ({ message: "You must acknowledge the deletion terms" }),
  }),
})

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 5, window: 60 })
  if (limited) return limited

  try {
    const body = await request.json()

    // Validate request body
    const validationResult = deletionRequestSchema.safeParse(body)
    if (!validationResult.success) {
      return NextResponse.json(
        { error: validationResult.error.errors[0].message },
        { status: 400 }
      )
    }

    const { email, confirmEmail, deletionType, additionalInfo } = validationResult.data

    // Verify emails match
    if (email !== confirmEmail) {
      return NextResponse.json(
        { error: "Email addresses do not match" },
        { status: 400 }
      )
    }

    const supabase = getSupabase()

    // Check if user exists
    const { data: users } = await supabase
      .from("users")
      .select("id, email")
      .eq("email", email.toLowerCase())
      .limit(1)

    // Also check auth.users
    const { data: authUser } = await supabase.auth.admin.listUsers()
    const matchingAuthUser = authUser?.users?.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    )

    // Store the deletion request
    const { error: insertError } = await supabase.from("data_deletion_requests").insert({
      email: email.toLowerCase(),
      user_id: users?.[0]?.id || matchingAuthUser?.id || null,
      deletion_type: deletionType,
      additional_info: additionalInfo || null,
      status: "pending",
      requested_at: new Date().toISOString(),
      ip_address: request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || null,
      user_agent: request.headers.get("user-agent") || null,
    })

    // Resolve a stable internal user id for logs. Never log the submitter's
    // email or any other PII — data-deletion is the one endpoint where leaking
    // PII into logs would be especially ironic.
    const resolvedUserId = users?.[0]?.id || matchingAuthUser?.id || null

    if (insertError) {
      // If the insert failed (e.g. table missing), leave a breadcrumb so ops
      // can still follow up — but only with non-identifying metadata.
      log.error("[Data Deletion Request] insert failed; request received but not persisted", {
        deletionType,
        userId: resolvedUserId,
        timestamp: new Date().toISOString(),
      })
    }

    // Log for compliance tracking — user id only, never email.
    log.info(`[GDPR/CCPA] Data deletion request received (type=${deletionType}, userId=${resolvedUserId ?? "unknown"})`)

    return NextResponse.json({
      success: true,
      message: "Your deletion request has been submitted and will be processed within 30 days.",
    })
  } catch (error) {
    log.error("[Data Deletion] Error processing request:", error)
    return NextResponse.json(
      { error: "Failed to process deletion request. Please try again." },
      { status: 500 }
    )
  }
}

// Meta requires a callback URL for data deletion requests
// This handles the Meta Data Deletion Callback
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 20, window: 60 })
  if (limited) return limited

  const url = new URL(request.url)
  const signedRequest = url.searchParams.get("signed_request")

  if (!signedRequest) {
    return NextResponse.json(
      { error: "Missing signed_request parameter" },
      { status: 400 }
    )
  }

  try {
    // Parse the signed request from Meta
    const [encodedSig, payload] = signedRequest.split(".")

    if (!payload) {
      return NextResponse.json(
        { error: "Invalid signed_request format" },
        { status: 400 }
      )
    }

    // Verify HMAC signature
    const appSecret = process.env.INSTAGRAM_APP_SECRET
    if (appSecret) {
      const expectedSig = crypto
        .createHmac("sha256", appSecret)
        .update(payload)
        .digest("base64url")
      if (encodedSig !== expectedSig) {
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
      }
    }

    // Decode the payload
    const decodedPayload = JSON.parse(
      Buffer.from(payload, "base64").toString("utf-8")
    )

    const userId = decodedPayload.user_id

    // Log the deletion request
    log.info(`[Meta Data Deletion] Request for user_id: ${userId}`)

    const supabase = getSupabase()

    // Find and mark Instagram connection for deletion
    if (userId) {
      await supabase
        .from("instagram_connections")
        .update({ is_active: false, deletion_requested_at: new Date().toISOString() })
        .eq("instagram_account_id", userId)
    }

    // Generate confirmation code
    const confirmationCode = `DEL-${Date.now().toString(36).toUpperCase()}`

    // Meta expects a specific response format
    return NextResponse.json({
      url: `${process.env.NEXT_PUBLIC_APP_URL || "https://managevelocity.com"}/data-deletion?confirmation=${confirmationCode}`,
      confirmation_code: confirmationCode,
    })
  } catch (error) {
    log.error("[Meta Data Deletion] Error:", error)
    return NextResponse.json(
      { error: "Failed to process deletion request" },
      { status: 500 }
    )
  }
}
