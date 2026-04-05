import * as crypto from "crypto"
import { safeFetch } from "./safe-fetch"
import { log } from "@/lib/log"

const GRAPH_API_VERSION = "v19.0"
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

// Cache Page ID lookups so we don't call /me on every message
const pageIdCache = new Map<string, { pageId: string; expires: number }>()

async function resolvePageId(accessToken: string, fallbackId?: string): Promise<string> {
  const cacheKey = accessToken.slice(-20)
  const cached = pageIdCache.get(cacheKey)
  if (cached && cached.expires > Date.now()) return cached.pageId

  try {
    const res = await safeFetch(`${GRAPH_API_BASE}/me?fields=id&access_token=${accessToken}`)
    if (res.ok) {
      const data = await res.json()
      if (data.id) {
        pageIdCache.set(cacheKey, { pageId: data.id, expires: Date.now() + 3600000 }) // 1hr cache
        return data.id
      }
    }
  } catch { /* fall through */ }

  return fallbackId || ""
}

interface InstagramUserInfo {
  name: string
  username: string
}

interface SendMessageResponse {
  recipient_id: string
  message_id: string
}

export interface InstagramCredentials {
  accessToken: string
  accountId: string
}

/**
 * Send a message to an Instagram user via the Instagram Graph API
 * Supports both per-user credentials and env var fallback
 */
export async function sendInstagramMessage(
  recipientId: string,
  message: string,
  credentials?: InstagramCredentials
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  // Use provided credentials or fall back to env vars
  const accessToken = credentials?.accessToken || process.env.INSTAGRAM_ACCESS_TOKEN
  const accountId = credentials?.accountId || process.env.INSTAGRAM_ACCOUNT_ID

  if (!accessToken || !accountId) {
    log.error("Instagram credentials not configured", undefined)
    return { success: false, error: "Instagram credentials not configured" }
  }

  // The messaging API requires the Page ID, not the Instagram Account ID.
  const pageId = await resolvePageId(accessToken, accountId)

  try {
    const response = await safeFetch(`${GRAPH_API_BASE}/${pageId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: message },
      }),
    })

    if (!response.ok) {
      const errorData = await response.json()
      log.error("Instagram API error:", errorData)
      return {
        success: false,
        error: errorData.error?.message || "Failed to send message",
      }
    }

    const data: SendMessageResponse = await response.json()
    return { success: true, messageId: data.message_id }
  } catch (error) {
    log.error("Error sending Instagram message:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Verify webhook signature from Meta
 * Meta sends X-Hub-Signature-256 header with HMAC-SHA256 signature
 */
export function verifyWebhookSignature(
  signature: string | null,
  body: string
): boolean {
  const appSecret = process.env.INSTAGRAM_APP_SECRET

  if (!appSecret) {
    log.error("INSTAGRAM_APP_SECRET not configured", undefined)
    return false
  }

  if (!signature) {
    log.error("No signature provided", undefined)
    return false
  }

  // Signature format: "sha256=xxxxx"
  const expectedSignature = crypto
    .createHmac("sha256", appSecret)
    .update(body)
    .digest("hex")

  const providedSignature = signature.replace("sha256=", "")

  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(providedSignature)
  )
}

/**
 * Get Instagram user information
 * Note: Only works for users who have messaged the business account
 */
export async function getInstagramUserInfo(
  userId: string,
  credentials?: InstagramCredentials
): Promise<InstagramUserInfo | null> {
  const accessToken = credentials?.accessToken || process.env.INSTAGRAM_ACCESS_TOKEN

  if (!accessToken) {
    log.error("Instagram access token not configured", undefined)
    return null
  }

  try {
    const response = await safeFetch(
      `${GRAPH_API_BASE}/${userId}?fields=name,username&access_token=${accessToken}`
    )

    if (!response.ok) {
      const errorData = await response.json()
      log.error("Error fetching Instagram user info:", errorData)
      return null
    }

    const data = await response.json()
    return {
      name: data.name || `Instagram User`,
      username: data.username || "",
    }
  } catch (error) {
    log.error("Error fetching Instagram user info:", error)
    return null
  }
}

/**
 * Parse Instagram webhook messaging event
 */
export interface InstagramMessage {
  senderId: string
  recipientId: string
  timestamp: number
  messageId: string
  text?: string
  attachments?: Array<{
    type: string
    payload: { url: string }
  }>
  isEcho?: boolean
}

export function parseInstagramWebhook(body: any): InstagramMessage | null {
  try {
    // Instagram webhook structure:
    // { object: "instagram", entry: [{ id, time, messaging: [{ sender, recipient, timestamp, message }] }] }

    if (body.object !== "instagram") {
      return null
    }

    const entry = body.entry?.[0]
    if (!entry) return null

    const messaging = entry.messaging?.[0]
    if (!messaging) return null

    // Skip echo messages (our own sent messages)
    if (messaging.message?.is_echo) {
      return null
    }

    return {
      senderId: messaging.sender?.id,
      recipientId: messaging.recipient?.id,
      timestamp: messaging.timestamp,
      messageId: messaging.message?.mid,
      text: messaging.message?.text,
      attachments: messaging.message?.attachments,
      isEcho: messaging.message?.is_echo,
    }
  } catch (error) {
    log.error("Error parsing Instagram webhook:", error)
    return null
  }
}

/**
 * Mark a message as seen (send read receipt)
 */
export async function markMessageSeen(
  senderId: string,
  credentials?: InstagramCredentials
): Promise<boolean> {
  const accessToken = credentials?.accessToken || process.env.INSTAGRAM_ACCESS_TOKEN

  if (!accessToken) {
    return false
  }

  const pageId = await resolvePageId(accessToken, credentials?.accountId)

  try {
    const response = await safeFetch(`${GRAPH_API_BASE}/${pageId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: senderId },
        sender_action: "mark_seen",
      }),
    })

    return response.ok
  } catch (error) {
    log.error("Error marking message as seen:", error)
    return false
  }
}

/**
 * Send typing indicator
 */
export async function sendTypingIndicator(
  senderId: string,
  typingOn: boolean,
  credentials?: InstagramCredentials
): Promise<boolean> {
  const accessToken = credentials?.accessToken || process.env.INSTAGRAM_ACCESS_TOKEN

  if (!accessToken) {
    return false
  }

  const pageId = await resolvePageId(accessToken, credentials?.accountId)

  try {
    const response = await safeFetch(`${GRAPH_API_BASE}/${pageId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        recipient: { id: senderId },
        sender_action: typingOn ? "typing_on" : "typing_off",
      }),
    })

    return response.ok
  } catch (error) {
    log.error("Error sending typing indicator:", error)
    return false
  }
}
