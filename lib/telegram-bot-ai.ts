import Anthropic from "@anthropic-ai/sdk"
import { createClient } from "@supabase/supabase-js"
import { log } from "@/lib/log"

// Initialize Supabase with service role for bot operations
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Lazy-initialized Anthropic client
let anthropicClient: Anthropic | null = null

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY environment variable is not set")
    }
    anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })
  }
  return anthropicClient
}

// Tool definitions for the AI agent
const tools: Anthropic.Tool[] = [
  {
    name: "get_vehicles",
    description: "Get a list of all vehicles in the user's fleet with their current status",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "update_vehicle_status",
    description: "Update a vehicle's status (available, rented, maintenance, inactive)",
    input_schema: {
      type: "object" as const,
      properties: {
        vehicle_id: {
          type: "string",
          description: "The UUID of the vehicle to update",
        },
        status: {
          type: "string",
          enum: ["available", "rented", "maintenance", "inactive"],
          description: "The new status for the vehicle",
        },
      },
      required: ["vehicle_id", "status"],
    },
  },
  {
    name: "search_vehicle",
    description: "Search for a vehicle by name, make, model, or year. Use this to find a vehicle before updating it.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'green huracan', '2023 ferrari', 'mclaren')",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "create_booking",
    description: "Create a new booking for a vehicle",
    input_schema: {
      type: "object" as const,
      properties: {
        vehicle_id: {
          type: "string",
          description: "The UUID of the vehicle to book",
        },
        customer_name: {
          type: "string",
          description: "Name of the customer",
        },
        customer_phone: {
          type: "string",
          description: "Phone number of the customer",
        },
        start_date: {
          type: "string",
          description: "Start date in YYYY-MM-DD format",
        },
        end_date: {
          type: "string",
          description: "End date in YYYY-MM-DD format",
        },
        notes: {
          type: "string",
          description: "Optional notes about the booking",
        },
      },
      required: ["vehicle_id", "customer_name", "start_date", "end_date"],
    },
  },
  {
    name: "get_bookings",
    description: "Get upcoming and recent bookings",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["pending", "confirmed", "completed", "cancelled", "all"],
          description: "Filter by booking status (default: all)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_leads",
    description: "Get recent leads from the CRM",
    input_schema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["new", "qualified", "pending", "booked", "lost", "cancelled", "followup", "all"],
          description: "Filter by lead status (default: all)",
        },
        limit: {
          type: "number",
          description: "Number of leads to return (default: 10)",
        },
      },
      required: [],
    },
  },
  {
    name: "update_lead_status",
    description: "Update a lead's status in the pipeline",
    input_schema: {
      type: "object" as const,
      properties: {
        lead_id: {
          type: "string",
          description: "The UUID of the lead to update",
        },
        status: {
          type: "string",
          enum: ["new", "qualified", "pending", "booked", "lost", "cancelled", "followup"],
          description: "The new status for the lead",
        },
      },
      required: ["lead_id", "status"],
    },
  },
  {
    name: "get_dashboard_summary",
    description: "Get a summary of the dashboard including vehicle count, active bookings, and recent leads",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
]

// Tool execution functions
async function executeTools(
  toolName: string,
  toolInput: Record<string, unknown>,
  userId: string
): Promise<string> {
  try {
    switch (toolName) {
      case "get_vehicles": {
        const { data, error } = await supabase
          .from("vehicles")
          .select("id, name, make, model, year, status, daily_rate, type")
          .eq("user_id", userId)
          .order("name")

        if (error) throw error

        if (!data || data.length === 0) {
          return "No vehicles found in your fleet."
        }

        const vehicleList = data.map(v =>
          `- ${v.name} (${v.year} ${v.make} ${v.model}) - Status: ${v.status.toUpperCase()} - $${v.daily_rate}/day`
        ).join("\n")

        return `Your fleet (${data.length} vehicles):\n${vehicleList}`
      }

      case "search_vehicle": {
        const query = (toolInput.query as string).toLowerCase()

        const { data, error } = await supabase
          .from("vehicles")
          .select("id, name, make, model, year, status, daily_rate, notes")
          .eq("user_id", userId)

        if (error) throw error

        const matches = data?.filter(v =>
          v.name.toLowerCase().includes(query) ||
          v.make.toLowerCase().includes(query) ||
          v.model.toLowerCase().includes(query) ||
          v.year.toString().includes(query) ||
          (v.notes && v.notes.toLowerCase().includes(query))
        )

        if (!matches || matches.length === 0) {
          return `No vehicles found matching "${toolInput.query}". Try a different search term.`
        }

        const results = matches.map(v =>
          `- ID: ${v.id}\n  ${v.name} (${v.year} ${v.make} ${v.model})\n  Status: ${v.status} | $${v.daily_rate}/day`
        ).join("\n\n")

        return `Found ${matches.length} vehicle(s):\n\n${results}`
      }

      case "update_vehicle_status": {
        const { vehicle_id, status } = toolInput as { vehicle_id: string; status: string }

        // Verify ownership
        const { data: vehicle, error: fetchError } = await supabase
          .from("vehicles")
          .select("id, name")
          .eq("id", vehicle_id)
          .eq("user_id", userId)
          .single()

        if (fetchError || !vehicle) {
          return "Vehicle not found or you don't have permission to update it."
        }

        const { error: updateError } = await supabase
          .from("vehicles")
          .update({ status })
          .eq("id", vehicle_id)

        if (updateError) throw updateError

        return `Updated "${vehicle.name}" status to ${status.toUpperCase()}.`
      }

      case "create_booking": {
        const { vehicle_id, customer_name, customer_phone, start_date, end_date, notes } =
          toolInput as {
            vehicle_id: string
            customer_name: string
            customer_phone?: string
            start_date: string
            end_date: string
            notes?: string
          }

        // Get vehicle info
        const { data: vehicle, error: vehicleError } = await supabase
          .from("vehicles")
          .select("id, name, daily_rate")
          .eq("id", vehicle_id)
          .eq("user_id", userId)
          .single()

        if (vehicleError || !vehicle) {
          return "Vehicle not found or you don't have permission to book it."
        }

        // Calculate total
        const start = new Date(start_date)
        const end = new Date(end_date)
        const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
        const total = days * vehicle.daily_rate

        const { data: booking, error: bookingError } = await supabase
          .from("bookings")
          .insert({
            user_id: userId,
            vehicle_id,
            customer_name,
            customer_phone: customer_phone || null,
            start_date,
            end_date,
            total_amount: total,
            status: "confirmed",
            notes: notes || null,
          })
          .select()
          .single()

        if (bookingError) throw bookingError

        // Update vehicle status to rented
        await supabase
          .from("vehicles")
          .update({ status: "rented" })
          .eq("id", vehicle_id)

        return `Booking created for ${vehicle.name}:\n- Customer: ${customer_name}\n- Dates: ${start_date} to ${end_date} (${days} days)\n- Total: $${total.toLocaleString()}\n- Vehicle marked as RENTED`
      }

      case "get_bookings": {
        const status = toolInput.status as string | undefined

        let query = supabase
          .from("bookings")
          .select("id, customer_name, start_date, end_date, status, total_amount, vehicles(name)")
          .eq("user_id", userId)
          .order("start_date", { ascending: true })
          .limit(15)

        if (status && status !== "all") {
          query = query.eq("status", status)
        }

        const { data, error } = await query

        if (error) throw error

        if (!data || data.length === 0) {
          return status && status !== "all"
            ? `No ${status} bookings found.`
            : "No bookings found."
        }

        const bookingList = data.map(b => {
          const vehicle = (b.vehicles as any)?.name || "Unknown vehicle"
          return `- ${vehicle} | ${b.customer_name}\n  ${b.start_date} to ${b.end_date} | ${b.status.toUpperCase()} | $${b.total_amount}`
        }).join("\n\n")

        return `Bookings (${data.length}):\n\n${bookingList}`
      }

      case "get_leads": {
        const status = toolInput.status as string | undefined
        const limit = (toolInput.limit as number) || 10

        let query = supabase
          .from("leads")
          .select("id, name, phone, status, source, vehicle_interest, created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(limit)

        if (status && status !== "all") {
          query = query.eq("status", status)
        }

        const { data, error } = await query

        if (error) throw error

        if (!data || data.length === 0) {
          return "No leads found."
        }

        const leadList = data.map(l =>
          `- ${l.name} (${l.phone})\n  Status: ${l.status} | Source: ${l.source || "unknown"}\n  Interest: ${l.vehicle_interest || "not specified"}`
        ).join("\n\n")

        return `Recent leads (${data.length}):\n\n${leadList}`
      }

      case "update_lead_status": {
        const { lead_id, status } = toolInput as { lead_id: string; status: string }

        const { data: lead, error: fetchError } = await supabase
          .from("leads")
          .select("id, name")
          .eq("id", lead_id)
          .eq("user_id", userId)
          .single()

        if (fetchError || !lead) {
          return "Lead not found or you don't have permission to update it."
        }

        const { error: updateError } = await supabase
          .from("leads")
          .update({ status })
          .eq("id", lead_id)

        if (updateError) throw updateError

        return `Updated lead "${lead.name}" status to ${status.toUpperCase()}.`
      }

      case "get_dashboard_summary": {
        const [vehiclesRes, bookingsRes, leadsRes] = await Promise.all([
          supabase
            .from("vehicles")
            .select("id, status")
            .eq("user_id", userId),
          supabase
            .from("bookings")
            .select("id, status, total_amount")
            .eq("user_id", userId)
            .gte("start_date", new Date().toISOString().split("T")[0]),
          supabase
            .from("leads")
            .select("id, status")
            .eq("user_id", userId)
            .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
        ])

        const vehicles = vehiclesRes.data || []
        const bookings = bookingsRes.data || []
        const leads = leadsRes.data || []

        const availableVehicles = vehicles.filter(v => v.status === "available").length
        const rentedVehicles = vehicles.filter(v => v.status === "rented").length
        const maintenanceVehicles = vehicles.filter(v => v.status === "maintenance").length

        const upcomingBookings = bookings.filter(b => b.status === "confirmed").length
        const pendingBookings = bookings.filter(b => b.status === "pending").length

        const newLeads = leads.filter(l => l.status === "new").length

        return `Dashboard Summary:

FLEET (${vehicles.length} total):
- Available: ${availableVehicles}
- Rented: ${rentedVehicles}
- Maintenance: ${maintenanceVehicles}

BOOKINGS (upcoming):
- Confirmed: ${upcomingBookings}
- Pending: ${pendingBookings}

LEADS (last 7 days):
- New leads: ${newLeads}
- Total: ${leads.length}`
      }

      default:
        return `Unknown tool: ${toolName}`
    }
  } catch (error: any) {
    log.error(`Tool execution error (${toolName}):`, error)
    return `Error executing ${toolName}: ${error.message}`
  }
}

// System prompt for the dashboard management bot
const SYSTEM_PROMPT = `You are a helpful AI assistant for managing an exotic car rental business dashboard. You can help the user:

1. **Manage Vehicles**: View fleet, update vehicle status (available, rented, maintenance, inactive)
2. **Handle Bookings**: Create new bookings, view upcoming/past bookings
3. **Track Leads**: View and update lead status in the sales pipeline

When the user mentions a vehicle by name, color, or partial description, use the search_vehicle tool first to find the exact vehicle ID before making updates.

For date references like "this weekend", "tomorrow", "next week", calculate the actual dates based on today being ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

Be concise but friendly. Use emojis sparingly to make responses feel less robotic. Always confirm actions you've taken.

If the user's request is unclear, ask for clarification rather than guessing.`

export interface TelegramBotResponse {
  message: string
  success: boolean
}

export async function processMessage(
  userMessage: string,
  userId: string,
  chatId: string
): Promise<TelegramBotResponse> {
  try {
    const client = getAnthropicClient()

    let messages: Anthropic.MessageParam[] = [
      { role: "user", content: userMessage }
    ]

    // Initial API call
    let response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    })

    // Process tool calls iteratively
    while (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      )

      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const toolUse of toolUseBlocks) {
        const result = await executeTools(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          userId
        )
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        })
      }

      // Add assistant response and tool results to messages
      messages = [
        ...messages,
        { role: "assistant", content: response.content },
        { role: "user", content: toolResults },
      ]

      // Continue the conversation
      response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      })
    }

    // Extract final text response
    const textContent = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text"
    )

    const finalMessage = textContent?.text || "I've completed the requested action."

    // Log the interaction
    await supabase.from("telegram_bot_logs").insert({
      user_id: userId,
      chat_id: chatId,
      message_text: userMessage,
      bot_response: finalMessage,
      action_taken: response.stop_reason,
    })

    return {
      message: finalMessage,
      success: true,
    }
  } catch (error: any) {
    log.error("Telegram bot AI error:", error)
    return {
      message: "Sorry, I encountered an error processing your request. Please try again.",
      success: false,
    }
  }
}

// Verify a link code and connect Telegram to user account
export async function verifyLinkCode(
  code: string,
  chatId: string,
  telegramUsername?: string
): Promise<{ success: boolean; message: string; userId?: string }> {
  try {
    // Find valid link code
    const { data: linkCode, error: codeError } = await supabase
      .from("telegram_link_codes")
      .select("id, user_id, expires_at, used_at")
      .eq("code", code.toUpperCase())
      .single()

    if (codeError || !linkCode) {
      return { success: false, message: "Invalid code. Please generate a new code from your dashboard." }
    }

    if (linkCode.used_at) {
      return { success: false, message: "This code has already been used." }
    }

    if (new Date(linkCode.expires_at) < new Date()) {
      return { success: false, message: "This code has expired. Please generate a new one from your dashboard." }
    }

    // Update profile with Telegram info
    const { error: updateError } = await supabase
      .from("profiles")
      .update({
        telegram_chat_id: chatId,
        telegram_username: telegramUsername || null,
        telegram_linked_at: new Date().toISOString(),
      })
      .eq("id", linkCode.user_id)

    if (updateError) throw updateError

    // Mark code as used
    await supabase
      .from("telegram_link_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("id", linkCode.id)

    return {
      success: true,
      message: "Your Telegram account has been linked successfully! You can now manage your dashboard by sending me messages.",
      userId: linkCode.user_id,
    }
  } catch (error: any) {
    log.error("Link verification error:", error)
    return { success: false, message: "An error occurred while linking your account." }
  }
}

// Get user by Telegram chat ID
export async function getUserByChatId(chatId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("telegram_chat_id", chatId)
    .single()

  if (error || !data) return null
  return data.id
}
