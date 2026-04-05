import { NextRequest, NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { generateResponse, ChatMessage, ModelId } from "@/lib/anthropic"
import { generateSecurePaymentLink, PaymentLinkData } from "@/lib/payment-link"
import { applyRateLimit } from "@/lib/api-rate-limit"

// Force Node.js runtime for Anthropic SDK compatibility
export const runtime = "nodejs"

/**
 * Get authenticated user from session
 * Returns null if not authenticated
 */
async function getAuthenticatedUser() {
  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) {
    return null
  }

  return user
}

interface Vehicle {
  id: string
  name: string
  make: string
  model: string
  year: number
  daily_rate: number
}

// Default vehicles as fallback if client doesn't send them
const DEFAULT_VEHICLES: Vehicle[] = [
  { id: "v1", name: "Lamborghini Huracan", make: "Lamborghini", model: "Huracan EVO", year: 2024, daily_rate: 1500 },
  { id: "v2", name: "Ferrari 488", make: "Ferrari", model: "488 Spider", year: 2023, daily_rate: 1800 },
  { id: "v3", name: "Rolls Royce Cullinan", make: "Rolls Royce", model: "Cullinan", year: 2024, daily_rate: 2000 },
  { id: "v4", name: "Mercedes G63 AMG", make: "Mercedes", model: "G63 AMG", year: 2024, daily_rate: 800 },
  { id: "v5", name: "Porsche 911 Turbo S", make: "Porsche", model: "911 Turbo S", year: 2024, daily_rate: 1200 },
]

interface LeadData {
  name: string
  phone: string
  email: string | null
  instagram_username: string | null
  collected_name: string | null
  collected_email: string | null
  collected_phone: string | null
  collected_vehicle_id: string | null
  collected_start_date: string | null
  collected_end_date: string | null
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    // Verify user is authenticated - don't trust client-provided userId
    const authenticatedUser = await getAuthenticatedUser()
    if (!authenticatedUser) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    const body = await request.json()
    const { messages, systemPrompt, model, forceModel, autoEscalate, vehicles, leadData, settings } = body

    // Use authenticated user's ID instead of client-provided userId
    const userId = authenticatedUser.id

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY not configured" },
        { status: 500 }
      )
    }

    // Build conversation messages for Anthropic
    const chatMessages: ChatMessage[] = messages.map((msg: { role: string; content: string }) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    }))

    // Determine model to use
    const requestedModel: ModelId = model || "claude-haiku-4-5-20251001"

    // Generate response using Anthropic Direct API with prompt caching
    const result = await generateResponse(
      systemPrompt,
      chatMessages,
      {
        model: requestedModel,
        maxTokens: 800, // Increased for structured data output
        temperature: 0.7,
        usePromptCaching: true,
        forceModel: forceModel || !autoEscalate,
      }
    )

    let aiResponse = result.content
    console.log("[Chatbot Test] Raw AI response:", aiResponse.substring(0, 500))

    // Parse extracted data from response
    let extractedData: {
      vehicleId?: string
      startDate?: string
      endDate?: string
      name?: string
      email?: string
      phone?: string
      confirmed?: boolean
    } | undefined

    const extractedMatch = aiResponse.match(/\[EXTRACTED\]([\s\S]*?)\[\/EXTRACTED\]/)
    console.log("[Chatbot Test] extractedMatch found:", !!extractedMatch)
    if (extractedMatch) {
      try {
        const data = JSON.parse(extractedMatch[1].trim())
        extractedData = {
          vehicleId: data.vehicle_id !== "null" && data.vehicle_id !== null ? data.vehicle_id : undefined,
          startDate: data.start_date !== "null" && data.start_date !== null ? data.start_date : undefined,
          endDate: data.end_date !== "null" && data.end_date !== null ? data.end_date : undefined,
          name: data.name !== "null" && data.name !== null ? data.name : undefined,
          email: data.email !== "null" && data.email !== null ? data.email : undefined,
          phone: data.phone !== "null" && data.phone !== null ? data.phone : undefined,
          confirmed: data.confirmed === true,
        }
        console.log("[Chatbot Test] Parsed extractedData:", JSON.stringify(extractedData, null, 2))
      } catch (e) {
        console.error("Failed to parse extracted data:", e)
      }

      // Remove the [EXTRACTED] block from the response
      aiResponse = aiResponse.replace(/\s*\[EXTRACTED\][\s\S]*?\[\/EXTRACTED\]\s*/, "").trim()
    }

    // Generate payment link if [SEND_PAYMENT_LINK] marker is present
    console.log("[Chatbot Test] Checking for [SEND_PAYMENT_LINK]:", aiResponse.includes("[SEND_PAYMENT_LINK]"))
    if (aiResponse.includes("[SEND_PAYMENT_LINK]")) {
      console.log("[Payment Link] Marker detected! Starting payment link generation...")
      aiResponse = aiResponse.replace("[SEND_PAYMENT_LINK]", "")
      aiResponse = aiResponse.trim()

      // Use default vehicles as fallback if none received from client
      const vehicleList: Vehicle[] = (vehicles && (vehicles as Vehicle[]).length > 0)
        ? vehicles as Vehicle[]
        : DEFAULT_VEHICLES

      console.log("[Payment Link] Using vehicle list with", vehicleList.length, "vehicles", vehicles ? "(from client)" : "(DEFAULT FALLBACK)")

      // Try to generate a real payment link
      const vehicleId = extractedData?.vehicleId || (leadData as LeadData)?.collected_vehicle_id
      const startDate = extractedData?.startDate || (leadData as LeadData)?.collected_start_date
      const endDate = extractedData?.endDate || (leadData as LeadData)?.collected_end_date
      // Use extracted name, or collected name from leadData, or instagram username, or fallback to "Customer"
      const customerName = extractedData?.name || (leadData as LeadData)?.collected_name || (leadData as LeadData)?.name || "Customer"
      const customerPhone = extractedData?.phone || (leadData as LeadData)?.collected_phone || (leadData as LeadData)?.phone || ""

      // Debug logging
      console.log("[Payment Link] extractedData:", extractedData)
      console.log("[Payment Link] leadData:", leadData)
      console.log("[Payment Link] vehicleId:", vehicleId, "startDate:", startDate, "endDate:", endDate)
      console.log("[Payment Link] vehicles count:", vehicleList.length)

      console.log("[Payment Link] Final check - vehicleId:", vehicleId, "startDate:", startDate, "endDate:", endDate, "vehicleList length:", vehicleList.length)

      if (vehicleId && startDate && endDate && vehicleList.length > 0) {
        console.log("[Payment Link] All data present, looking up vehicle:", vehicleId)
        console.log("[Payment Link] Available vehicles:", vehicleList.map((v: Vehicle) => ({ id: v.id, name: v.name, make: v.make, model: v.model })))

        // Try to find vehicle by ID first, then by name/make/model match
        let vehicle = vehicleList.find((v: Vehicle) => v.id === vehicleId)

        if (!vehicle) {
          // AI might have output vehicle name instead of ID - try matching by name
          const vehicleIdLower = vehicleId.toLowerCase()
          vehicle = vehicleList.find((v: Vehicle) => {
            const fullName = `${v.year} ${v.make} ${v.model}`.toLowerCase()
            const shortName = `${v.make} ${v.model}`.toLowerCase()
            return fullName === vehicleIdLower ||
                   shortName === vehicleIdLower ||
                   (vehicleIdLower.includes(v.make.toLowerCase()) && vehicleIdLower.includes(v.model.toLowerCase()))
          })
          if (vehicle) {
            console.log("[Payment Link] Found vehicle by name match:", vehicle.name)
          }
        }

        if (vehicle) {
          console.log("[Payment Link] Found vehicle:", vehicle.name, "with daily_rate:", vehicle.daily_rate)
          // Calculate number of days
          const start = new Date(startDate)
          const end = new Date(endDate)
          const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)))

          const totalAmount = vehicle.daily_rate * days
          const depositPercentage = settings?.deposit_percentage || 25
          const depositAmount = Math.round(totalAmount * (depositPercentage / 100))

          try {
            const paymentData: PaymentLinkData = {
              vehicleId: vehicle.id,
              vehicleName: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
              startDate,
              endDate,
              dailyRate: vehicle.daily_rate,
              totalAmount,
              depositAmount,
              customerName,
              customerPhone,
              businessName: settings?.business_name || "Velocity Exotics",
              // Include user ID for booking creation and Stripe key lookup
              userId: userId || undefined,
              // NOTE: Stripe keys are NOT stored in payment links for security
              // They are looked up from deposit_portal_config at checkout time
              // Include custom payment domain (defaults to rentalcapture.xyz)
              paymentDomain: settings?.payment_domain || settings?.custom_domain || undefined,
              // Include company slug for URL path on default domain
              companySlug: settings?.company_slug || undefined,
            }

            const paymentLink = await generateSecurePaymentLink(paymentData)
            aiResponse += `\n\nHere's your secure payment link: ${paymentLink}`
          } catch (error) {
            console.error("Failed to generate payment link:", error)
            aiResponse += "\n\n[Payment link generation failed - please contact us directly]"
          }
        } else {
          console.log("[Payment Link] Vehicle not found in list!")
          aiResponse += "\n\n[Could not find vehicle information for payment link]"
        }
      } else {
        console.log("[Payment Link] Missing data - vehicleId:", !!vehicleId, "startDate:", !!startDate, "endDate:", !!endDate, "vehicleList length:", vehicleList.length)
        aiResponse += "\n\n[Missing booking details for payment link - please provide vehicle and dates]"
      }
    }

    return NextResponse.json({
      response: aiResponse,
      model: result.model,
      escalated: result.escalated,
      escalationReason: result.escalationReason,
      usage: result.usage,
      cost: result.cost,
      extractedData,
    })

  } catch (error: any) {
    // Log full error server-side only; never leak details to the client.
    console.error("Chatbot test error:", error)

    if (error?.message?.includes("ANTHROPIC_API_KEY")) {
      return NextResponse.json(
        { error: "Service misconfigured" },
        { status: 500 }
      )
    }

    if (error?.status === 401) {
      return NextResponse.json(
        { error: "Service authentication failed" },
        { status: 502 }
      )
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
