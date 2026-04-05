import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import {
  processMessage,
  verifyLinkCode,
  getUserByChatId,
} from "@/lib/telegram-bot-ai"
import { applyRateLimit } from "@/lib/api-rate-limit"
import { claimWebhookEvent } from "@/lib/webhook-idempotency"
import { safeFetch } from "@/lib/safe-fetch"
import { log } from "@/lib/log"

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN

// Verify the webhook request is from Telegram
// Uses the secret_token set when configuring the webhook via setWebhook API
function verifyTelegramRequest(request: NextRequest): boolean {
  // If TELEGRAM_WEBHOOK_SECRET is set, verify the header
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!webhookSecret) {
    log.error("[telegram.webhook] TELEGRAM_WEBHOOK_SECRET not set", new Error("missing_secret"), { route: "telegram.webhook" })
    return false
  }

  const secretHeader = request.headers.get("x-telegram-bot-api-secret-token")
  return secretHeader === webhookSecret
}

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from: {
      id: number
      is_bot: boolean
      first_name: string
      username?: string
    }
    chat: {
      id: number
      first_name?: string
      username?: string
      type: string
    }
    date: number
    text?: string
  }
}

// Send message via Telegram API
async function sendTelegramMessage(chatId: string | number, text: string) {
  if (!TELEGRAM_BOT_TOKEN) {
    log.error("[telegram.webhook] TELEGRAM_BOT_TOKEN not configured", new Error("missing_bot_token"), { route: "telegram.webhook" })
    return
  }

  try {
    const response = await safeFetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
        timeoutMs: 10_000,
      }
    )

    if (!response.ok) {
      // Do not log raw Telegram error body (may echo chat ids / usernames).
      await response.text().catch(() => null)
      log.error("[telegram.webhook] api error", new Error("telegram_api_error"), { status: response.status, route: "telegram.webhook" })
    }
  } catch (error) {
    log.error("[telegram.webhook] send failed", error, { route: "telegram.webhook" })
  }
}

export async function POST(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 100, window: 60 })
  if (limited) return limited

  // Verify the request is from Telegram
  if (!verifyTelegramRequest(request)) {
    log.warn("[telegram.webhook] invalid webhook secret", { route: "telegram.webhook" })
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const update: TelegramUpdate = await request.json()

    // LB-4 / R-3: idempotency. Telegram retries on timeout, and without a
    // claim the bot will run its AI tool-calls (update_vehicle_status,
    // create_booking, …) twice on every redelivery. `update_id` is
    // monotonically increasing and unique per bot.
    const claim = await claimWebhookEvent(
      "telegram",
      String(update.update_id),
      update.message ? "message" : "other"
    )
    if (!claim.claimed) {
      return NextResponse.json({ ok: true, duplicate: true })
    }

    // Only process text messages
    if (!update.message?.text) {
      return NextResponse.json({ ok: true })
    }

    const chatId = update.message.chat.id.toString()
    const messageText = update.message.text.trim()
    const username = update.message.from.username

    // Handle /start command
    if (messageText === "/start") {
      await sendTelegramMessage(
        chatId,
        `Welcome to your Dashboard Manager Bot! 🚗\n\nTo get started, you need to link your account:\n\n1. Go to your dashboard Settings\n2. Find the "Telegram Bot" section\n3. Click "Generate Link Code"\n4. Send me the 6-digit code\n\nOnce linked, you can manage your fleet, bookings, and leads right from Telegram!`
      )
      return NextResponse.json({ ok: true })
    }

    // Handle /help command
    if (messageText === "/help") {
      await sendTelegramMessage(
        chatId,
        `*Dashboard Manager Bot Commands*\n\nYou can send me natural language messages like:\n\n*Fleet Management:*\n- "Show my vehicles"\n- "Mark the Huracan as rented"\n- "Set Ferrari to maintenance"\n\n*Bookings:*\n- "Show upcoming bookings"\n- "Book the McLaren for John Smith from Friday to Sunday"\n\n*Leads:*\n- "Show new leads"\n- "Mark lead as contacted"\n\n*Dashboard:*\n- "Give me a summary"\n- "What's my status?"\n\nJust type naturally and I'll help you manage your dashboard!`
      )
      return NextResponse.json({ ok: true })
    }

    // Check if this is a link code (6 alphanumeric characters)
    if (/^[A-Z0-9]{6}$/i.test(messageText)) {
      const result = await verifyLinkCode(messageText, chatId, username)
      await sendTelegramMessage(chatId, result.message)
      return NextResponse.json({ ok: true })
    }

    // Check if user is linked
    const userId = await getUserByChatId(chatId)

    if (!userId) {
      await sendTelegramMessage(
        chatId,
        "Your Telegram account is not linked to a dashboard.\n\nTo link your account:\n1. Go to your dashboard Settings\n2. Find \"Telegram Bot\" section\n3. Click \"Generate Link Code\"\n4. Send me the 6-digit code"
      )
      return NextResponse.json({ ok: true })
    }

    // Process the message with AI
    const response = await processMessage(messageText, userId, chatId)
    await sendTelegramMessage(chatId, response.message)

    return NextResponse.json({ ok: true })
  } catch (error) {
    log.error("[telegram.webhook] unhandled error", error, { route: "telegram.webhook" })
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

// Telegram sends GET request to verify webhook
export async function GET(request: NextRequest) {
  const limited = await applyRateLimit(request, { limit: 100, window: 60 })
  if (limited) return limited

  return NextResponse.json({ status: "Telegram webhook is active" })
}
