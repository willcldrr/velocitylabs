import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createClient as createServerClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { encrypt } from "@/lib/crypto"

// Service role client bypasses RLS
const serviceSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Helper to verify admin
async function verifyAdmin(request: NextRequest): Promise<{ isAdmin: boolean; userId?: string; error?: string }> {
  try {
    const supabase = await createServerClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return { isAdmin: false, error: "Unauthorized" }
    }

    const { data: profile } = await serviceSupabase
      .from("profiles")
      .select("is_admin")
      .eq("id", user.id)
      .single()

    if (!profile?.is_admin) {
      return { isAdmin: false, error: "Admin access required" }
    }

    return { isAdmin: true, userId: user.id }
  } catch (err) {
    return { isAdmin: false, error: "Auth error" }
  }
}

// GET - List all businesses
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const { isAdmin, error } = await verifyAdmin(request)
  if (!isAdmin) {
    return NextResponse.json({ error }, { status: error === "Unauthorized" ? 401 : 403 })
  }

  const { data: businesses, error: dbError } = await serviceSupabase
    .from("businesses")
    .select("id, name, slug, status, created_at, owner_id, logo_url, primary_color, stripe_publishable_key, payment_domain")
    .order("created_at", { ascending: false })

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ businesses })
}

// POST - Create a new business
export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const { isAdmin, error } = await verifyAdmin(request)
  if (!isAdmin) {
    return NextResponse.json({ error }, { status: error === "Unauthorized" ? 401 : 403 })
  }

  const body = await request.json()

  if (!body.name || !body.slug) {
    return NextResponse.json({ error: "Name and slug are required" }, { status: 400 })
  }

  // LB-6 dual-write: encrypt the Stripe secret key and also keep the
  // plaintext column populated until the drop migration ships.
  // TODO(LB-6 cutover): remove plaintext write after drop migration
  let encryptedStripeSecretKey: string | null = null
  let stripeSecretKeyIv: string | null = null
  let stripeSecretKeyTag: string | null = null
  if (body.stripe_secret_key) {
    const enc = encrypt(body.stripe_secret_key)
    encryptedStripeSecretKey = enc.ciphertext
    stripeSecretKeyIv = enc.iv
    stripeSecretKeyTag = enc.tag
  }

  const { data, error: dbError } = await serviceSupabase
    .from("businesses")
    .insert({
      name: body.name,
      slug: body.slug,
      payment_domain: body.payment_domain || null,
      domain_status: body.domain_status || "pending",
      stripe_publishable_key: body.stripe_publishable_key || null,
      stripe_secret_key: body.stripe_secret_key || null,
      encrypted_stripe_secret_key: encryptedStripeSecretKey,
      stripe_secret_key_iv: stripeSecretKeyIv,
      stripe_secret_key_tag: stripeSecretKeyTag,
      stripe_connected: !!(body.stripe_publishable_key && body.stripe_secret_key),
      logo_url: body.logo_url || null,
      primary_color: body.primary_color || "#FFFFFF",
      secondary_color: body.secondary_color || "#000000",
      phone: body.phone || null,
      email: body.email || null,
      address: body.address || null,
      business_hours: body.business_hours || null,
      deposit_percentage: body.deposit_percentage || 25,
      status: body.status || "active",
    })
    .select()
    .single()

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ business: data })
}

// PATCH - Update business (full update or status only)
export async function PATCH(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const { isAdmin, error } = await verifyAdmin(request)
  if (!isAdmin) {
    return NextResponse.json({ error }, { status: error === "Unauthorized" ? 401 : 403 })
  }

  const body = await request.json()
  const { businessId } = body

  if (!businessId) {
    return NextResponse.json({ error: "businessId is required" }, { status: 400 })
  }

  // Build update object with only provided fields
  const updateData: Record<string, unknown> = {}

  if (body.name !== undefined) updateData.name = body.name
  if (body.slug !== undefined) updateData.slug = body.slug
  if (body.payment_domain !== undefined) updateData.payment_domain = body.payment_domain
  if (body.domain_status !== undefined) updateData.domain_status = body.domain_status
  if (body.stripe_publishable_key !== undefined) updateData.stripe_publishable_key = body.stripe_publishable_key
  if (body.stripe_secret_key !== undefined) {
    // LB-6 dual-write: keep plaintext column populated until the drop
    // migration runs. TODO(LB-6 cutover): remove plaintext write after
    // drop migration.
    updateData.stripe_secret_key = body.stripe_secret_key
    if (body.stripe_secret_key) {
      const enc = encrypt(body.stripe_secret_key)
      updateData.encrypted_stripe_secret_key = enc.ciphertext
      updateData.stripe_secret_key_iv = enc.iv
      updateData.stripe_secret_key_tag = enc.tag
    } else {
      updateData.encrypted_stripe_secret_key = null
      updateData.stripe_secret_key_iv = null
      updateData.stripe_secret_key_tag = null
    }
  }
  if (body.stripe_connected !== undefined) updateData.stripe_connected = body.stripe_connected
  if (body.logo_url !== undefined) updateData.logo_url = body.logo_url
  if (body.primary_color !== undefined) updateData.primary_color = body.primary_color
  if (body.secondary_color !== undefined) updateData.secondary_color = body.secondary_color
  if (body.phone !== undefined) updateData.phone = body.phone
  if (body.email !== undefined) updateData.email = body.email
  if (body.address !== undefined) updateData.address = body.address
  if (body.business_hours !== undefined) updateData.business_hours = body.business_hours
  if (body.deposit_percentage !== undefined) updateData.deposit_percentage = body.deposit_percentage
  if (body.status !== undefined) {
    const validStatuses = ["active", "inactive", "suspended", "pending"]
    if (!validStatuses.includes(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 })
    }
    updateData.status = body.status
  }

  if (Object.keys(updateData).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 })
  }

  const { error: dbError } = await serviceSupabase
    .from("businesses")
    .update(updateData)
    .eq("id", businessId)

  if (dbError) {
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}

// DELETE - Delete a business
export async function DELETE(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  const { isAdmin, error } = await verifyAdmin(request)
  if (!isAdmin) {
    return NextResponse.json({ error }, { status: error === "Unauthorized" ? 401 : 403 })
  }

  const { searchParams } = new URL(request.url)
  const businessId = searchParams.get("id")

  if (!businessId) {
    return NextResponse.json({ error: "Business ID is required" }, { status: 400 })
  }

  const { error: dbError } = await serviceSupabase
    .from("businesses")
    .delete()
    .eq("id", businessId)

  if (dbError) {
    console.error("Error deleting business:", dbError)
    return NextResponse.json({ error: dbError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
