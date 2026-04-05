import { NextRequest, NextResponse } from "next/server"
import { generateResponse, ChatMessage, ModelId } from "@/lib/anthropic"
import { createClient } from "@/lib/supabase/server"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { log } from "@/lib/log"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 30, window: 60 })
  if (limited) return limited

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // Only allow authenticated admin users
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const body = await request.json()
    const { messages, model = "claude-sonnet-4-6" } = body
    const systemPrompt = "You are Velocity AI, a helpful assistant for managing an exotic car rental business dashboard. Help the user with questions about their leads, bookings, vehicles, and analytics."

    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY not configured" },
        { status: 500 }
      )
    }

    const chatMessages: ChatMessage[] = messages.map((msg: { role: string; content: string }) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    }))

    const result = await generateResponse(
      systemPrompt,
      chatMessages,
      {
        model: model as ModelId,
        maxTokens: 2000,
        temperature: 0.8,
        forceModel: true,
      }
    )

    return NextResponse.json({
      response: result.content,
      model: result.model,
      usage: result.usage,
      cost: result.cost,
    })

  } catch (error: any) {
    // F-13: never return raw error messages to the client; log server-side.
    log.error("[velocity-ai] unhandled error", error, { route: "velocity-ai" })
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
