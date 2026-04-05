import { NextRequest, NextResponse } from "next/server"
import { createClient as createServiceClient } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"

// Use service role to bypass RLS
function getSupabaseService() {
  return createServiceClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 5, window: 60 })
  if (limited) return limited

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { companyName, email, phone, fullName } = body

    if (!companyName) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      )
    }

    const userId = user.id
    const supabaseService = getSupabaseService()

    // Ensure profile exists (upsert to handle potential race conditions)
    const { error: profileError } = await supabaseService
      .from("profiles")
      .upsert({
        id: userId,
        full_name: fullName || null,
        company_name: companyName,
        email: email || null,
        phone: phone || null,
        is_admin: false,
      }, {
        onConflict: "id",
        ignoreDuplicates: true,
      })

    if (profileError) {
      console.error("Profile creation error:", profileError)
      // Continue anyway - profile might already exist from auth trigger
    }

    // Generate unique slug
    const slug = companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") + "-" + Date.now().toString(36)

    // Check if business already exists for this user
    const { data: existingBusiness } = await supabaseService
      .from("businesses")
      .select("id")
      .eq("owner_user_id", userId)
      .single()

    if (existingBusiness) {
      return NextResponse.json({ success: true, businessId: existingBusiness.id })
    }

    // Create the business record
    const { data: business, error: businessError } = await supabaseService
      .from("businesses")
      .insert({
        name: companyName,
        slug,
        owner_user_id: userId,
        email: email || null,
        phone: phone || null,
        status: "pending",
        domain_status: "pending",
      })
      .select("id")
      .single()

    if (businessError) {
      console.error("Business creation error:", businessError)
      return NextResponse.json(
        { error: "Failed to create business" },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, businessId: business.id })
  } catch (error) {
    console.error("Signup business API error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
